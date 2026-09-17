#!/usr/bin/env node
// socialcrabs-service/scripts/connect-session.js
// ─────────────────────────────────────────────────────────────────────────────
// Runs on YOUR machine, never on the server. It produces a platform session and
// hands it to the engine over HTTPS. There are three ways to get one:
//
//   1. --login            opens a real browser; you sign in on the platform's
//                         own page (your password goes to Instagram/X/LinkedIn,
//                         not to Ariana, not to this script, not to the engine);
//                         the script then lifts the resulting session.
//   2. --cookies-file f   imports a cookie export you already have (a JSON array
//                         of cookies or a Playwright storageState file).
//   3. --auth-token + --ct0   X only: two values copied from a logged-in browser.
//
// What it sends: the session (cookies + localStorage) to
// POST /api/sessions/<account>/import on the engine, authenticated with the
// engine's API key. What it never does: print cookie values, write them to disk,
// or store them locally.
//
//   node scripts/connect-session.js --platform instagram --handle ariana.personal \
//        --login --engine https://engine.example.com --key $ENGINE_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const caps = require('../src/capabilities');

const LOGIN_URL = {
  instagram: 'https://www.instagram.com/accounts/login/',
  twitter: 'https://x.com/i/flow/login',
  linkedin: 'https://www.linkedin.com/login',
};

const DOMAIN = {
  instagram: '.instagram.com',
  twitter: '.x.com',
  linkedin: '.linkedin.com',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function usage(exitCode = 0) {
  console.log(`
Give the engine a login for one account — run this on your own machine.

  node scripts/connect-session.js --platform <p> --handle <h> [mode] [options]

Required
  --platform <instagram|twitter|linkedin>
  --handle <the account's username/handle>

One of
  --login                        open a browser and sign in yourself (recommended)
  --cookies-file <file.json>     import cookies exported from a browser you use
  --auth-token <token> --ct0 <token>   X only, two cookies from a logged-in browser

Options
  --engine <url>       engine base URL         (or env SOCIAL_ENGINE_URL)
  --key <api key>      engine API key          (or env SOCIAL_ENGINE_API_KEY)
  --account-id <id>    override the account id (default: <platform>:<handle>)
  --headless           run the login browser headless (no, you want to see it)
  --timeout <minutes>  how long to wait for you to finish logging in (default 5)

Nothing is printed that could be a credential, and nothing is written to disk.
`.trim());
  process.exit(exitCode);
}

async function postSession({ engine, key, accountId, platform, handle, session }) {
  const url = `${engine.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(accountId)}/import`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({ platform, handle, session }),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`The engine refused the session (HTTP ${res.status}): ${data.error || text}`);
  }
  return data;
}

function criticalCookie(platform) {
  return (caps.platformInfo(platform) || {}).session_cookie;
}

function normalizeCookie(c, platform) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain || DOMAIN[platform],
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : (typeof c.expirationDate === 'number' ? c.expirationDate : undefined),
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite === true ? 'Lax' : (typeof c.sameSite === 'string' ? c.sameSite : undefined),
  };
}

function readCookiesFile(file, platform) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let cookies = [];
  let localStorage = {};
  if (Array.isArray(raw)) cookies = raw;
  else if (Array.isArray(raw.cookies)) {
    cookies = raw.cookies;
    // Playwright storageState keeps localStorage per origin
    for (const origin of raw.origins || []) {
      for (const item of origin.localStorage || []) localStorage[item.name] = item.value;
    }
  } else {
    throw new Error('Unrecognised cookie file: expected a JSON array of cookies or a Playwright storageState object.');
  }
  return { cookies: cookies.map((c) => normalizeCookie(c, platform)), localStorage };
}

async function loginWithBrowser({ platform, headless, timeoutMinutes }) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    throw new Error(
      'Playwright is not installed here. From socialcrabs-service/ run "npm install" (it brings Playwright) ' +
      'and "npx playwright install chromium", then try again. Or use --cookies-file instead.'
    );
  }

  console.log('› opening a browser — sign in on the platform\'s own page. Nothing you type leaves your machine.');
  const browser = await chromium.launch({ headless: !!headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL[platform], { waitUntil: 'domcontentloaded' }).catch(() => {});

  const needed = criticalCookie(platform);
  const deadline = Date.now() + Math.max(1, Number(timeoutMinutes) || 5) * 60 * 1000;
  let found = null;
  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    found = cookies.find((c) => c.name === needed && c.value);
    if (found) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!found) {
    await browser.close().catch(() => {});
    throw new Error(`Timed out waiting for the "${needed}" cookie — the login did not complete. Nothing was sent.`);
  }

  // Give the app a moment to finish writing its own storage, then lift it.
  await new Promise((r) => setTimeout(r, 1500));
  const cookies = await context.cookies();
  const localStorage = {};
  for (const origin of await context.storageState().then((s) => s.origins || []).catch(() => [])) {
    for (const item of origin.localStorage || []) localStorage[item.name] = item.value;
  }
  await browser.close().catch(() => {});

  return { cookies: cookies.map((c) => normalizeCookie(c, platform)), localStorage };
}

function xFromTokens(authToken, ct0) {
  const now = Math.floor(Date.now() / 1000);
  return {
    cookies: [
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, expires: now + 180 * 24 * 3600 },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
    ],
    localStorage: {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) usage(0);

  const platform = String(args.platform || '').toLowerCase();
  const handle = args.handle ? String(args.handle).replace(/^@/, '') : null;
  const engine = args.engine || process.env.SOCIAL_ENGINE_URL;
  const key = args.key || process.env.SOCIAL_ENGINE_API_KEY;

  if (!platform || !handle) {
    console.error('✖ --platform and --handle are required.\n');
    usage(1);
  }
  if (!caps.platformInfo(platform)) {
    console.error(`✖ "${platform}" has no adapter in this engine. Supported: ${caps.platformIds().join(', ')}.`);
    process.exit(1);
  }
  if (!engine) { console.error('✖ --engine (or SOCIAL_ENGINE_URL) is required — the deployed engine\'s URL.'); process.exit(1); }
  if (!key) { console.error('✖ --key (or SOCIAL_ENGINE_API_KEY) is required — the engine will reject the session without it.'); process.exit(1); }

  const accountId = args.accountId || `${platform}:${handle.toLowerCase()}`;
  const modes = [!!args.login, !!args.cookiesFile, !!(args.authToken && args.ct0)].filter(Boolean).length;
  if (modes !== 1) {
    console.error('✖ Choose exactly one way to get the session: --login, --cookies-file, or --auth-token with --ct0.\n');
    usage(1);
  }

  let session;
  if (args.login) {
    session = await loginWithBrowser({ platform, headless: args.headless, timeoutMinutes: args.timeout });
  } else if (args.cookiesFile) {
    const file = path.resolve(String(args.cookiesFile));
    if (!fs.existsSync(file)) { console.error(`✖ No such file: ${file}`); process.exit(1); }
    session = readCookiesFile(file, platform);
  } else {
    if (platform !== 'twitter') {
      console.error('✖ --auth-token/--ct0 only applies to X. Use --login or --cookies-file for this platform.');
      process.exit(1);
    }
    session = xFromTokens(args.authToken, args.ct0);
  }

  const needed = criticalCookie(platform);
  if (!session.cookies.some((c) => c.name === needed && c.value)) {
    console.error(`✖ That session has no "${needed}" cookie, so it is not logged in. Nothing was sent.`);
    process.exit(1);
  }

  console.log(`› sending session for ${accountId} (${session.cookies.length} cookies) to ${engine}`);
  const result = await postSession({ engine, key, accountId, platform, handle, session });
  console.log(`✓ stored${result.session && result.session.encrypted ? ' (encrypted at rest)' : ''}.`);
  console.log('  Next: in Ariana\'s dashboard → Social → press Connect on this account.');
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
