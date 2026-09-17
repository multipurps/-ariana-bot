// socialcrabs-service/src/session-vault.js
// ─────────────────────────────────────────────────────────────────────────────
// Encrypted storage for the platform sessions the engine holds.
//
// A session is the whole login: cookies (and a little localStorage) for
// Instagram, X or LinkedIn. SocialCrabs itself writes those sessions as plain
// JSON in its session directory — fine on a laptop, not fine on a server. So
// the engine never keeps them that way at rest:
//
//   SESSION_DIR/<account>/session.enc   ← AES-256-GCM, key derived from
//                                          COOKIE_ENCRYPTION_KEY
//   SESSION_DIR/<account>/meta.json     ← platform + handle + timestamps only,
//                                          no cookie values
//
// While a browser is actually running, the runtime needs the cookies as a file
// (SocialCrabs reads them from disk), so a decrypted copy is materialised into
// a scratch directory — outside the repo and outside the mounted volume — and
// removed again when the browser is closed or the engine shuts down.
//
// Two safeguards against a wedge that never logs the account out cleanly:
//   · a session is only written when it still contains the platform's critical
//     cookie (sessionid / auth_token / li_at) — this mirrors SocialCrabs' own
//     guard so a logged-out snapshot can never overwrite a good session;
//   · every action re-encrypts the refreshed session, so the vault copy stays
//     current and the 7-day staleness rule in SocialCrabs never triggers.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const caps = require('./capabilities');

const MAGIC = Buffer.from('ARIV1');
const SESSION_DIR = process.env.SESSION_DIR || '/data/sessions';
const SCRATCH_ROOT = process.env.ENGINE_SCRATCH_DIR || path.join(os.tmpdir(), 'ariana-social-engine');
const INSECURE = process.env.ALLOW_INSECURE_SESSION_STORAGE === '1';

function accountDir(accountId) {
  return path.join(SESSION_DIR, safeName(accountId));
}

function scratchDir(accountId) {
  return path.join(SCRATCH_ROOT, safeName(accountId), 'runtime');
}

function safeName(accountId) {
  return String(accountId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function key() {
  const secret = process.env.COOKIE_ENCRYPTION_KEY || process.env.ENGINE_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest(); // 32 bytes
}

function keyFingerprint() {
  const k = key();
  return k ? k.toString('hex').slice(0, 8) : null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function encrypt(obj) {
  const k = key();
  if (!k) {
    if (!INSECURE) throw new Error('COOKIE_ENCRYPTION_KEY is not set — refusing to store sessions unencrypted. Set it, or set ALLOW_INSECURE_SESSION_STORAGE=1 to accept plaintext on a throwaway dev box.');
    return Buffer.concat([MAGIC, Buffer.from('0'), Buffer.from(JSON.stringify(obj))]); // magic + flag
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from('1'), iv, tag, body]);
}

function decrypt(buf) {
  if (buf.length < 5 || !buf.slice(0, 5).equals(MAGIC)) throw new Error('Unrecognised session file.');
  const flagged = buf.slice(5, 6).toString();
  const rest = buf.slice(6);
  if (flagged === '0') return JSON.parse(rest.toString('utf8'));
  const k = key();
  if (!k) throw new Error('COOKIE_ENCRYPTION_KEY is not set — cannot decrypt the stored session.');
  const iv = rest.slice(0, 12);
  const tag = rest.slice(12, 28);
  const body = rest.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

// A session is only worth storing if the platform's own login cookie is in it.
function hasCriticalCookie(platform, session) {
  const needed = (caps.platformInfo(platform) || {}).session_cookie;
  if (!needed || !session || !Array.isArray(session.cookies)) return false;
  return session.cookies.some((c) => c && c.name === needed && c.value);
}

function normalizeSession(platform, session) {
  const now = Date.now();
  return {
    platform,
    cookies: (session.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || defaultDomain(platform),
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : (typeof c.expirationDate === 'number' ? c.expirationDate : undefined),
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: c.sameSite === true ? 'Lax' : (typeof c.sameSite === 'string' ? c.sameSite : undefined),
    })),
    localStorage: session.localStorage || {},
    createdAt: session.createdAt || now,
    updatedAt: now,
    username: session.username || session.handle || undefined,
  };
}

function defaultDomain(platform) {
  if (platform === 'instagram') return '.instagram.com';
  if (platform === 'twitter') return '.x.com';
  if (platform === 'linkedin') return '.linkedin.com';
  return '';
}

// ── PUBLIC API ──────────────────────────────────────────────────────────────

function exists(accountId) {
  try { return fs.existsSync(path.join(accountDir(accountId), 'session.enc')); } catch (_) { return false; }
}

function meta(accountId) {
  try { return JSON.parse(fs.readFileSync(path.join(accountDir(accountId), 'meta.json'), 'utf8')); } catch (_) { return null; }
}

function writeMeta(accountId, data) {
  ensureDir(accountDir(accountId));
  const file = path.join(accountDir(accountId), 'meta.json');
  fs.writeFileSync(file, JSON.stringify({ ...(meta(accountId) || {}), ...data, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

// Stores a session (encrypted) and the non-secret metadata.
function save(accountId, platform, session, extra = {}) {
  const normalized = normalizeSession(platform, session);
  if (!hasCriticalCookie(platform, normalized)) {
    return { ok: false, error: `That session has no "${(caps.platformInfo(platform) || {}).session_cookie || 'login'}" cookie, so it is not logged in. Nothing was stored — log in first, then export the session.` };
  }
  ensureDir(accountDir(accountId));
  fs.writeFileSync(path.join(accountDir(accountId), 'session.enc'), encrypt(normalized), { mode: 0o600 });
  writeMeta(accountId, {
    account_id: accountId,
    platform,
    handle: extra.handle || normalized.username || null,
    cookies: normalized.cookies.length,
    updated_at: new Date().toISOString(),
    ...extra,
  });
  return { ok: true, meta: meta(accountId) };
}

function load(accountId, platform) {
  const file = path.join(accountDir(accountId), 'session.enc');
  if (!fs.existsSync(file)) return null;
  try {
    const session = decrypt(fs.readFileSync(file));
    if (platform && session.platform && session.platform !== platform) {
      throw new Error(`Stored session is for ${session.platform}, not ${platform}.`);
    }
    return session;
  } catch (e) {
    console.warn(`[vault] could not read session for ${accountId}: ${e.message}`);
    return null;
  }
}

function remove(accountId) {
  const dir = accountDir(accountId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[vault] could not remove ${dir}: ${e.message}`); }
  return { ok: true };
}

// The engine's runtime needs a plain file while a browser is up.
function materialize(accountId, platform, session) {
  const dir = scratchDir(accountId);
  ensureDir(dir);
  const file = path.join(dir, `${platform}.json`);
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  return file;
}

function clearScratch(accountId) {
  try { fs.rmSync(path.join(SCRATCH_ROOT, safeName(accountId)), { recursive: true, force: true }); } catch (_) {}
}

function list() {
  try {
    return fs.readdirSync(SESSION_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ dir: d.name, meta: meta(d.name) || { account_id: d.name }, has_session: exists(d.name) }));
  } catch (_) {
    return [];
  }
}

module.exports = {
  SESSION_DIR,
  SCRATCH_ROOT,
  accountDir,
  scratchDir,
  key,
  keyFingerprint,
  exists,
  meta,
  writeMeta,
  save,
  load,
  remove,
  materialize,
  clearScratch,
  list,
  hasCriticalCookie,
  normalizeSession,
  encrypt,
  decrypt,
};
