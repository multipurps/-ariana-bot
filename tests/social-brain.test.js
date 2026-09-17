// tests/social-brain.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's side of the social layer, without a browser anywhere in sight.
//
// The other suites cover the contract (manifest, guards, tools) and the engine
// service. This one covers the wiring between them:
//
//   · store    — accounts, permissions, activity and autonomy config survive a
//                restart; activity is capped and newest-first;
//   · activity — every entry is a sentence a person could read, and the counter
//                the daily limits rely on only counts things that happened;
//   · accounts — multi-account resolution never guesses, and the prompt block
//                tells her the truth about her own hands;
//   · autonomy — off until the creator turns it on, only ever looks at real
//                reads, never acts on a disabled account, and can always say no;
//   · api      — the dashboard routes are behind the same gate as /api/talk,
//                report "brands not connected" honestly, and mint confirmations
//                that only a human can create;
//   · index    — she is offered no tools at all when there is nothing to act
//                through, and her prompt says why.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-'));
process.env.SOCIAL_DATA_DIR = path.join(TMP, 'data');
process.env.SOCIAL_ENGINE_URL = '';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SOCIAL_DRY_RUN;

const social = require('../social');
const accounts = require('../social/accounts');
const activity = require('../social/activity');
const store = require('../social/store');
const autonomy = require('../social/autonomy');
const guards = require('../social/guards');
const tools = require('../social/tools');

// Reloads every social module, the way a redeploy would, so persistence can be
// tested for real rather than against an in-memory cache.
function restartSocial() {
  for (const file of Object.keys(require.cache)) {
    if (file.includes(`${path.sep}social${path.sep}`)) delete require.cache[file];
  }
  return {
    social: require('../social'),
    accounts: require('../social/accounts'),
    activity: require('../social/activity'),
    store: require('../social/store'),
    autonomy: require('../social/autonomy'),
    guards: require('../social/guards'),
    tools: require('../social/tools'),
  };
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ── STORE ───────────────────────────────────────────────────────────────────

test('store: with no Supabase configured it says so and keeps state in files', async () => {
  assert.equal(store.usingSupabase(), false);
  assert.ok(store.DATA_DIR.startsWith(TMP), 'the data dir is honoured');
});

test('store: accounts, permissions and activity survive a restart', async () => {
  const first = restartSocial();
  const added = await first.accounts.add({ platform: 'instagram', handle: '@ariana.personal', label: 'Personal' });
  assert.equal(added.ok, true);
  await first.accounts.setActionsEnabled(added.account.account_id, true);
  await first.activity.record({ account: added.account, action: 'like', target: 'https://www.instagram.com/p/abc/', status: 'completed' });

  const second = restartSocial();
  const list = await second.accounts.list();
  assert.equal(list.length, 1, 'the register survived');
  assert.equal(list[0].account_id, 'instagram:ariana.personal');
  assert.equal(list[0].actions_enabled, true, 'the creator switch survived');
  const rows = await second.activity.recent(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'like');

  // The activity file is private and the accounts file is not world-readable.
  const mode = fs.statSync(path.join(store.DATA_DIR, 'accounts.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'the register is written 0600');
});

test('store: newest activity first, reads capped', async () => {
  const { activity: a, accounts: acc } = restartSocial();
  const account = (await acc.list())[0];
  for (let i = 0; i < 5; i++) {
    await a.record({ account, action: 'view_profile', target: `user${i}`, status: 'completed' });
  }
  const rows = await a.recent(3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].summary.includes('user4'), true, 'the newest entry comes first');
});

// ── ACTIVITY ────────────────────────────────────────────────────────────────

test('activity: every status reads as a sentence, never as a server log', () => {
  const cases = [
    ['completed', 'like', 'Liked @someone\'s post'],
    ['failed', 'like', 'Could not like @someone\'s post'],
    ['blocked', 'follow', 'Could not follow @someone — stopped by a limit or permission'],
    ['needs_confirmation', 'dm', 'DM to @someone failed — waiting for your confirmation'],
    ['unsupported', 'post', 'Posting failed — not supported by Instagram'],
    ['skipped', 'like', 'Liked @someone\'s post — skipped (nothing was sent)'],
    ['partial', 'comment', 'Commented on @someone\'s post — partly done'],
  ];
  for (const [status, action, expected] of cases) {
    const row = { status, action, target_handle: '@someone', target: null, platform: 'instagram', error: 'Stack: TypeError at line 42' };
    assert.equal(activity.buildSummary(row), expected, status);
  }
  // The failure line never carries the raw error text.
  const failed = activity.buildSummary({ status: 'failed', action: 'like', target_handle: 'someone', platform: 'instagram', error: 'TimeoutError: waiting for selector' });
  assert.equal(/TimeoutError|selector/.test(failed), false);
});

test('activity: a noisy error is clamped to one readable line', () => {
  const noisy = "Cannot find module 'socialcrabs'\nRequire stack:\n- /app/src/engine.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1433)";
  assert.equal(activity.clampError(noisy), "Cannot find module 'socialcrabs'");
  assert.equal(activity.clampError(''), null);
  assert.equal(activity.clampError(null), null);
  const wall = 'x'.repeat(900);
  assert.equal(activity.clampError(wall).length, 400);
  assert.ok(activity.clampError(wall).endsWith('…'));

  // Until an old row scrolls away, the dashboard must not print a stack either.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /socReasonText\(e\.error\)/);
  assert.match(html, /function socReasonText/);
});

test('activity: a URL target is shortened, a missing one says nothing', () => {
  const withUrl = activity.buildSummary({ status: 'completed', action: 'like', target: 'https://www.instagram.com/p/Cabcdefghijkl/', platform: 'instagram' });
  assert.equal(withUrl, 'Liked a post');
  assert.equal(activity.buildSummary({ status: 'completed', action: 'search', target: 'ai agents', platform: 'linkedin' }), 'Searched for "ai agents"');
  assert.equal(activity.buildSummary({ status: 'completed', action: 'post', platform: 'twitter' }), 'Published a post');
});

test('activity: the daily counter only counts things that really happened', async () => {
  const { activity: a, accounts: acc } = restartSocial();
  const account = (await acc.list())[0];
  const before = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });

  await a.record({ account, action: 'comment', target: 'x', status: 'blocked', error: 'daily limit reached' });
  await a.record({ account, action: 'comment', target: 'x', status: 'needs_confirmation' });
  await a.record({ account, action: 'comment', target: 'x', status: 'unsupported' });
  await a.record({ account, action: 'comment', target: 'x', status: 'skipped' });
  const still = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });
  assert.equal(still, before, 'blocked/needs_confirmation/unsupported/skipped never count');

  await a.record({ account, action: 'comment', target: 'x', status: 'completed' });
  await a.record({ account, action: 'comment', target: 'x', status: 'partial' });
  const after = await a.countSince(24 * 60 * 60 * 1000, { accountId: account.account_id, action: 'comment' });
  assert.equal(after, before + 2, 'completed and partial both spent real actions');
});

// ── ACCOUNTS ────────────────────────────────────────────────────────────────

test('accounts: several accounts per platform, each with its own state', async () => {
  const { accounts: acc } = restartSocial();
  await acc.add({ platform: 'instagram', handle: 'ariana.creator' });
  await acc.add({ platform: 'twitter', handle: 'ArianaReyes' });

  const list = await acc.list();
  assert.equal(list.filter((a) => a.platform === 'instagram').length, 2);
  assert.equal(list.find((a) => a.account_id === 'twitter:arianareyes').handle, 'ArianaReyes');

  await acc.setStatus('instagram:ariana.creator', acc.STATUS.ONLINE, 'verified');
  await acc.setActionsEnabled('instagram:ariana.creator', true);
  const other = await acc.get('instagram:ariana.personal');
  assert.equal(other.status, 'not_connected', 'statuses do not bleed between accounts');
  assert.equal(other.actions_enabled, true);
});

test('accounts: an unknown platform is refused with the supported list', async () => {
  const { accounts: acc } = restartSocial();
  const out = await acc.add({ platform: 'tiktok', handle: 'someone' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Unknown platform "tiktok"/);
  assert.match(out.error, /instagram/);
});

test('accounts: resolution names the candidates instead of picking one', async () => {
  const { accounts: acc } = restartSocial();

  const byId = await acc.resolve('instagram:ariana.personal');
  assert.equal(byId.ok, true);
  assert.equal(byId.account.handle, 'ariana.personal');

  const byHandle = await acc.resolve('@ArianaReyes');
  assert.equal(byHandle.ok, true);
  assert.equal(byHandle.account.platform, 'twitter');

  const ambiguous = await acc.resolve('ariana');
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'ambiguous_account');
  assert.match(ambiguous.error, /instagram:ariana\.personal/);
  assert.match(ambiguous.error, /instagram:ariana\.creator/);

  const scoped = await acc.resolve('ariana.creator', 'instagram');
  assert.equal(scoped.ok, true);

  const nothing = await acc.resolve(null);
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'account_required');

  const missing = await acc.resolve('nobody');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'account_not_found');
});

test('accounts: the prompt says who is usable and who is switched off', async () => {
  const { accounts: acc } = restartSocial();
  await acc.setStatus('instagram:ariana.personal', acc.STATUS.ERROR, 'The platform says this session is not logged in.');
  const text = await acc.describeForPrompt();
  assert.match(text, /Instagram @ariana\.personal \(account_id: instagram:ariana\.personal\) — not usable right now/);
  assert.match(text, /Instagram @ariana\.creator.*connected/);
  assert.match(text, /X @ArianaReyes.*actions disabled by your creator/);
});

// ── AUTONOMY ────────────────────────────────────────────────────────────────

test('autonomy: off by default, and a restart does not turn it on', async () => {
  const fresh = restartSocial();
  const cfg = await fresh.autonomy.getConfig();
  assert.equal(cfg.enabled, false, 'nobody opted her in');
  assert.equal(cfg.allow_follow, false);
  assert.equal(fresh.autonomy.isDue(cfg), false, 'a disabled autonomy run is never due');
  assert.equal(fresh.autonomy.isDue({ ...cfg, enabled: true, last_run_at: new Date().toISOString() }), false, 'a fresh run is not due again immediately');
});

test('autonomy: a decision is parsed strictly, and rubbish means "no"', () => {
  assert.deepStrictEqual(autonomy.parseDecision('{"decide":"like","reason":"nice"}'), { decide: 'like', comment: null, reason: 'nice' });
  assert.equal(autonomy.parseDecision('{"decide":"follow","reason":"r"}').decide, 'follow');
  assert.equal(autonomy.parseDecision('{"decide":"dm","reason":"r"}').decide, 'skip', 'she cannot decide to do something that was not offered');
  assert.equal(autonomy.parseDecision('I think I will like it!').decide, 'skip');
  assert.equal(autonomy.parseDecision('').decide, 'skip');
  const long = autonomy.parseDecision(JSON.stringify({ decide: 'comment', comment: 'x'.repeat(900) }));
  assert.equal(long.comment.length, 500, 'a comment is clamped');
});

test('autonomy: the decision prompt gives her room to do nothing', () => {
  const prompt = autonomy.decisionPrompt(
    { platform: 'instagram', url: 'https://www.instagram.com/p/1/', handle: 'someone' },
    { handle: 'ariana.personal' },
    autonomy.DEFAULT_CONFIG,
    ['like', 'comment']
  );
  assert.match(prompt, /Most posts deserve nothing/);
  assert.match(prompt, /Never write anything that reads like marketing/);
  assert.match(prompt, /Actions available to you right now: like, comment/);
  assert.match(prompt, /"decide": "skip" \| "like" \| "comment" \| "follow"/);
});

test('autonomy: with no engine it refuses to pretend, and says what to set', async () => {
  const fresh = restartSocial();
  const out = await fresh.autonomy.runOnce({ trigger: 'manual' });
  assert.equal(out.ok, false);
  assert.match(out.error, /SOCIAL_ENGINE_URL/);
});

test('autonomy: she only looks at real reads, only acts on a live enabled account, and may decline', async () => {
  const fresh = restartSocial();
  const savedFetch = global.fetch;
  process.env.SOCIAL_ENGINE_URL = 'http://engine.test';
  process.env.SOCIAL_ENGINE_API_KEY = 'k';
  try {

    // Only a scan read is answered, and an action only if she decides to act.
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
      if (String(url).includes('/actions/view_posts')) {
        return json({ success: true, result: { success: true, data: ['https://www.instagram.com/p/one/', 'https://www.instagram.com/p/two/'] } });
      }
      if (String(url).includes('/actions/like')) {
        return json({ success: true, result: { success: true, platform: 'instagram', action: 'like' } });
      }
      if (String(url).includes('/health')) return json({ status: 'ok', provider: 'socialcrabs' });
      return json({}, 404);
    };

    const account = await fresh.accounts.get('instagram:ariana.creator');
    await fresh.accounts.setStatus(account.account_id, fresh.accounts.STATUS.ONLINE, 'verified');
    const off = await fresh.accounts.get('instagram:ariana.personal');
    assert.equal(off.actions_enabled, true);
    assert.notEqual(off.status, 'online', 'the second account is not verified — she must not act through it');

    // Her brain says: like the first thing, skip the rest.
    fresh.autonomy.attach({ askBrain: async () => '{"decide":"like","reason":"it is genuinely good"}' });
    const out = await fresh.autonomy.runOnce({ trigger: 'manual' });

    assert.equal(out.ok, true);
    assert.ok(out.acted >= 1, `she acted: ${JSON.stringify(out)}`);
    const decoded = calls.map((c) => ({ ...c, url: decodeURIComponent(c.url) }));
    const reads = decoded.filter((c) => c.url.includes('/view_posts'));
    assert.ok(reads.length >= 1, 'candidates come from a real read');
    assert.equal(reads.every((c) => c.url.includes('instagram:ariana.creator')), true, 'reads only ever used the online account');
    const likes = decoded.filter((c) => c.url.includes('/actions/like'));
    assert.ok(likes.length >= 1 && likes.length <= fresh.autonomy.DEFAULT_CONFIG.max_actions_per_tick, `the per-tick budget was respected (${likes.length} likes)`);
    assert.equal(likes[0].url.includes('instagram:ariana.creator'), true, 'and only through the live account');

    // The run is recorded for the dashboard.
    const cfg = await fresh.autonomy.getConfig();
    assert.ok(cfg.last_run_at);
    assert.equal(cfg.last_run_summary.acted, out.acted);
    assert.equal(cfg.last_run_summary.skipped, out.skipped);

    // A declining brain spends nothing.
    const before = calls.filter((c) => c.url.includes('/actions/like')).length;
    fresh.autonomy.attach({ askBrain: async () => '{"decide":"skip","reason":"not worth it"}' });
  const quiet = await fresh.autonomy.runOnce({ trigger: 'manual' });
  assert.equal(quiet.acted, 0);
  assert.equal(calls.filter((c) => c.url.includes('/actions/like')).length, before, 'nothing was sent');
  } finally {
    process.env.SOCIAL_ENGINE_URL = '';
    delete process.env.SOCIAL_ENGINE_API_KEY;
    global.fetch = savedFetch;
  }
});

// ── API ─────────────────────────────────────────────────────────────────────
// Each dashboard test gets its own data directory and its own module instances,
// the way a fresh deploy would: no test can be helped or hurt by another one's
// leftovers.

let dirCounter = 0;

async function startDashboard() {
  // eslint-disable-next-line global-require
  const express = require('express');
  process.env.SOCIAL_DATA_DIR = path.join(TMP, `dash-${++dirCounter}`);
  const fresh = restartSocial();
  const app = express();
  app.use(express.json());
  fresh.social.attach(app, {
    requireAuth: (req, res, next) => (req.get('x-dashboard-key') === 'sekret' ? next() : res.status(401).json({ ok: false, error: 'Unauthorized' })),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const stop = () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); };
  return { base: `http://127.0.0.1:${server.address().port}`, stop, fresh };
}

async function api(base, urlPath, { method = 'GET', body, key = 'sekret' } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dashboard-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('api: the social routes sit behind the same dashboard gate as /api/talk', async () => {
  const { base, stop } = await startDashboard();
  try {
    const denied = await api(base, '/api/social/status', { key: null });
    assert.equal(denied.status, 401);
    const allowed = await api(base, '/api/social/status');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.ok, true);
  } finally { stop(); }
});

test('api: with no engine the status route says so, with steps to fix it', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  const { base, stop } = await startDashboard();
  try {
    const { json } = await api(base, '/api/social/status');
    assert.equal(json.engine.configured, false);
    assert.equal(json.engine.reachable, false);
    assert.match(json.engine.error, /SOCIAL_ENGINE_URL/);
    assert.ok(Array.isArray(json.setup.steps) && json.setup.steps.length >= 3, 'real setup steps, not an error code');
    assert.match(json.setup.volume, /SESSION_DIR/);
    assert.equal(json.dry_run, false);
    assert.equal(json.autonomy.enabled, false);
  } finally { stop(); }
});

test('api: capabilities fall back to the bundled manifest while the engine is away', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  const { base, stop } = await startDashboard();
  try {
    const { json } = await api(base, '/api/social/capabilities');
    assert.equal(json.source, 'bundled');
    assert.match(json.note, /No engine connected/);
    const ig = json.capabilities.platforms.find((p) => p.id === 'instagram');
    assert.ok(ig.supported.some((s) => s.action === 'like'));
    assert.ok(ig.unsupported.some((u) => u.action === 'post' && u.reason.length > 10), 'every refusal carries a reason');
  } finally { stop(); }
});

test('api: adding an account reports what it will be able to do', async () => {
  const { base, stop } = await startDashboard();
  try {
    const added = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: '@ArianaDaily' } });
    assert.equal(added.status, 200);
    assert.equal(added.json.account.account_id, 'twitter:arianadaily');
    assert.equal(added.json.account.status, 'not_connected');
    assert.ok(added.json.account.capabilities.supported.some((s) => s.action === 'post'));
    assert.equal(added.json.account.capabilities.supported.some((s) => s.action === 'search'), false);

    const dupe = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: '@ArianaDaily' } });
    assert.equal(dupe.status, 400);
    assert.match(dupe.json.error, /already in the list/);

    const bad = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'tiktok', handle: 'x' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Unknown platform/);

    const listed = await api(base, '/api/social/accounts');
    assert.equal(listed.json.accounts.length, 1);
  } finally { stop(); }
});

test('api: Connect without an engine is a 503 with the setup, never a fake success', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'linkedin', handle: 'ariana-reyes' } });
    const out = await api(base, '/api/social/accounts/linkedin:ariana-reyes/connect', { method: 'POST' });
    assert.equal(out.status, 503);
    assert.equal(out.json.ok, false);
    assert.match(out.json.error, /not connected/i);
    assert.ok(out.json.setup.steps.length >= 3);
  } finally { stop(); }
});

test('api: the creator switch is per account and reported back', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'instagram', handle: 'ariana.personal' } });
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'instagram', handle: 'ariana.creator' } });

    const on = await api(base, '/api/social/accounts/instagram:ariana.creator/enable', { method: 'POST' });
    assert.equal(on.json.account.actions_enabled, true);
    const other = (await api(base, '/api/social/accounts')).json.accounts.find((a) => a.account_id === 'instagram:ariana.personal');
    assert.equal(other.actions_enabled, false, 'switching one account on leaves the other alone');

    const off = await api(base, '/api/social/accounts/instagram:ariana.creator/disable', { method: 'POST' });
    assert.equal(off.json.account.actions_enabled, false);
  } finally { stop(); }
});

test('api: autopublish cannot be switched on where publishing does not exist', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'linkedin', handle: 'ariana-reyes' } });
    const out = await api(base, '/api/social/accounts/linkedin:ariana-reyes/autopublish', { method: 'POST', body: { enabled: true } });
    assert.equal(out.status, 422);
    assert.match(out.json.error, /publish/i);

    // X can publish, so there the same switch is allowed.
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'twitter', handle: 'ArianaDaily' } });
    const okSwitch = await api(base, '/api/social/accounts/twitter:arianadaily/autopublish', { method: 'POST', body: { enabled: true } });
    assert.equal(okSwitch.status, 200);
    assert.equal(okSwitch.json.account.autopublish, true);
  } finally { stop(); }
});

test('api: manual actions run through the same guards Ariana uses', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'linkedin', handle: 'ariana-reyes' } });

    // Switched off: the permission gate stops it, and the log still describes it.
    const blocked = await api(base, '/api/social/actions/like', { method: 'POST', body: { account: 'linkedin:ariana-reyes', url: 'https://www.linkedin.com/feed/update/urn:li:share:1' } });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'actions_disabled');
    assert.match(blocked.json.summary, /stopped by a limit or permission/);

    const unknown = await api(base, '/api/social/actions/sing', { method: 'POST', body: {} });
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /is not an action Ariana can take/);

    const unsupported = await api(base, '/api/social/actions/post', { method: 'POST', body: { account: 'linkedin:ariana-reyes', text: 'hello' } });
    assert.equal(unsupported.status, 422, JSON.stringify(unsupported.json));
    assert.match(unsupported.json.error, /publish/i);

    // Switched on, but there is still no engine: "not connected", not a success.
    await api(base, '/api/social/accounts/linkedin:ariana-reyes/enable', { method: 'POST' });
    const noEngine = await api(base, '/api/social/actions/like', { method: 'POST', body: { account: 'linkedin:ariana-reyes', url: 'https://www.linkedin.com/feed/update/urn:li:share:1' } });
    assert.equal(noEngine.status, 503, JSON.stringify(noEngine.json));
    assert.equal(noEngine.json.code, 'not_configured');

    // And it is in the activity log, saying what really happened: the sentence
    // describes the attempt, the error field says why, in words.
    const log = await api(base, '/api/social/activity');
    const last = log.json.activity[0];
    assert.equal(last.status, 'failed');
    assert.equal(last.summary, 'Could not like the post');
    assert.match(last.error, /engine not connected/i);
    assert.match(last.error, /SOCIAL_ENGINE_URL/);
    assert.equal(last.status_label, 'Failed');
  } finally { stop(); }
});

test('api: only the dashboard can mint a confirmation, and it is scoped and single use', async () => {
  const { base, stop } = await startDashboard();
  try {
    await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'instagram', handle: 'ariana.personal' } });

    const listed = await api(base, '/api/social/confirmations');
    const before = listed.json.confirmations.length;

    const minted = await api(base, '/api/social/confirmations', {
      method: 'POST',
      body: { account_id: 'instagram:ariana.personal', action: 'unfollow', max_targets: 2, note: 'cleanup' },
    });
    assert.equal(minted.status, 200, JSON.stringify(minted.json));
    assert.ok(minted.json.token.length > 10);
    assert.ok(minted.json.expires_in_ms > 0, 'confirmations expire');
    assert.deepStrictEqual(minted.json.scope, { account_id: 'instagram:ariana.personal', action: 'unfollow', max_targets: 2 });

    const again = await api(base, '/api/social/confirmations');
    assert.equal(again.json.confirmations.length, before + 1);

    const missingAction = await api(base, '/api/social/confirmations', { method: 'POST', body: {} });
    assert.equal(missingAction.status, 400);
  } finally { stop(); }
});

test('api: activity comes back newest first with a human summary and a raw detail', async () => {
  const { base, stop, fresh } = await startDashboard();
  try {
    const added = await api(base, '/api/social/accounts', { method: 'POST', body: { platform: 'instagram', handle: 'ariana.personal' } });
    const account = added.json.account;
    await fresh.activity.record({ account, action: 'like', target: 'https://www.instagram.com/p/Cxyz/', target_handle: 'someone', status: 'completed' });
    await fresh.activity.record({ account, action: 'dm', target_handle: 'someone', status: 'failed', error: 'TimeoutError: waiting for selector', detail: { raw: 'stack trace' } });

    const { json } = await api(base, '/api/social/activity');
    assert.equal(json.activity.length, 2);
    assert.equal(json.activity[0].summary, 'DM to @someone failed');
    assert.equal(json.activity[0].status_label, 'Failed');
    assert.equal(json.activity[0].error, 'TimeoutError: waiting for selector', 'the raw reason is available for View details');
    assert.equal(json.activity[0].platform_label, 'Instagram');
    assert.equal(json.activity[1].summary, "Liked @someone's post");
    assert.equal(json.activity[1].target, 'https://www.instagram.com/p/Cxyz/');
  } finally { stop(); }
});

test('api: autonomy is reported as off and can be turned on and off', async () => {
  const { base, stop } = await startDashboard();
  try {
    const off = await api(base, '/api/social/autonomy');
    assert.equal(off.json.autonomy.enabled, false);

    const on = await api(base, '/api/social/autonomy', {
      method: 'POST',
      body: { enabled: true, interval_minutes: 240, watchlist: { instagram: ['@someone'] }, linkedin_searches: ['ai agents'] },
    });
    assert.equal(on.json.autonomy.enabled, true);
    assert.equal(on.json.autonomy.interval_minutes, 240);
    assert.deepStrictEqual(on.json.autonomy.watchlist.instagram, ['someone'], 'handles are cleaned');

    const back = await api(base, '/api/social/autonomy', { method: 'POST', body: { enabled: false } });
    assert.equal(back.json.autonomy.enabled, false);
  } finally { stop(); }
});

test('api: no route anywhere accepts a password or a cookie', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'social', 'api.js'), 'utf8');
  // Comments and the operator instructions may explain why there is no password
  // field; no code path may actually handle one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/password\s*[:=]|passwd|passphrase/i.test(code), false, 'nothing assigns or reads a password');
  assert.equal(/req\.body\.password|body\.password/i.test(code), false, 'no request body carries a password');
  assert.equal(/req\.get\(['"]cookie|req\.headers\.cookie/i.test(code), false, 'no route accepts cookies from the browser');
  assert.equal(/\bcookie\b/i.test(code), false, 'the code never touches cookies at all');
  const routes = [...source.matchAll(/r\.(get|post|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.ok(routes.length >= 12, `the dashboard surface is present (${routes.length} routes)`);
  assert.equal(routes.some((r) => /password|login|credential|cookie/i.test(r)), false, 'no credentials route exists');
});

// ── READS ───────────────────────────────────────────────────────────────────

test('reads: platforms answer in their own shape, callers see one', () => {
  assert.deepStrictEqual(
    tools.normalizeResult('view_posts', { success: true, data: ['https://www.instagram.com/p/one/', 'https://www.instagram.com/p/two/'] }),
    { posts: ['https://www.instagram.com/p/one/', 'https://www.instagram.com/p/two/'] }
  );
  assert.deepStrictEqual(
    tools.normalizeResult('search', { success: true, data: { html_chars: 5100, posts: [{ url: 'https://www.linkedin.com/feed/update/urn:li:share:1', urn: 'urn:li:share:1' }] } }),
    { posts: ['https://www.linkedin.com/feed/update/urn:li:share:1'] }
  );
  assert.deepStrictEqual(tools.normalizeResult('search', { success: true, data: { html_chars: 10, posts: [] } }), { posts: [] }, 'a read that found nothing is an empty list, never a guess');
  assert.equal(tools.normalizeResult('like', { success: true }), null);
  assert.deepStrictEqual(
    tools.normalizeResult('view_profile', { success: true, data: { username: 'someone', followers: 10 } }),
    { profile: { username: 'someone', followers: 10 } }
  );
});

// ── WIRING (social/index.js) ────────────────────────────────────────────────

test('wiring: with no engine she is handed no social tools at all', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-off');
  const { social: fresh } = restartSocial();
  await fresh.accounts.add({ platform: 'instagram', handle: 'ariana.personal' });
  await fresh.accounts.setActionsEnabled('instagram:ariana.personal', true);

  const schemas = await fresh.buildToolSchemas();
  assert.deepStrictEqual(schemas, [], 'tools she could only fail with are not offered — even for an enabled account');

  const block = await fresh.socialPromptBlock();
  assert.match(block, /YOUR SOCIAL ACCOUNTS/);
  assert.match(block, /backend is not reachable right now/, 'she is told the backend is down rather than finding out mid-action');
  assert.match(block, /never claim you did something you didn't/i);
});

test('wiring: with actions switched off everywhere she is told, not left guessing', async () => {
  process.env.SOCIAL_ENGINE_URL = 'http://engine.test';
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-disabled');
  const { social: fresh } = restartSocial();
  await fresh.accounts.add({ platform: 'instagram', handle: 'ariana.personal' });
  await fresh.accounts.add({ platform: 'twitter', handle: 'ArianaDaily' });

  assert.deepStrictEqual(await fresh.buildToolSchemas(), []);
  const block = await fresh.socialPromptBlock();
  assert.match(block, /actions turned OFF|turned OFF for/i);
  assert.match(block, /tell them plainly that actions are switched off/i);
  assert.equal(/social_\* tools/.test(block), false, 'she is not told she has tools she does not have');
});

test('wiring: with an engine and an enabled account the tools appear, with the honest list', async () => {
  process.env.SOCIAL_ENGINE_URL = 'http://engine.test';
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-on');
  const { social: fresh } = restartSocial();
  await fresh.accounts.add({ platform: 'twitter', handle: 'ArianaDaily' });
  await fresh.accounts.setActionsEnabled('twitter:arianadaily', true);

  const schemas = await fresh.buildToolSchemas();
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes('social_post'), 'X can publish');
  assert.ok(names.includes('social_repost'), 'X can repost');
  assert.equal(names.includes('social_search'), false, 'X cannot search, so she is not offered it');
  assert.ok(names.includes('social_accounts'), 'she can always ask what she has');

  const block = await fresh.socialPromptBlock();
  assert.match(block, /X @ArianaDaily \(account_id: twitter:arianadaily\) — connected|X @ArianaDaily \(account_id: twitter:arianadaily\) — connection not verified/);
  assert.match(block, /name the account when you act/i);
});

test('wiring: the boot line says exactly what is true', async () => {
  process.env.SOCIAL_ENGINE_URL = '';
  process.env.SOCIAL_DATA_DIR = path.join(TMP, 'wiring-boot');
  const { social: fresh } = restartSocial();
  const lines = await fresh.startupLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Social actions: ❌ no engine \(set SOCIAL_ENGINE_URL\)/);
  const readiness = await fresh.readiness();
  assert.equal(readiness.engine_configured, false);
  assert.equal(readiness.enabled, 0, 'nothing is enabled by default');
});

// Restore the shared data dir so the earlier tests in this file keep their state.
process.env.SOCIAL_DATA_DIR = path.join(TMP, 'data');
