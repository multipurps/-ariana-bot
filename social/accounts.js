// social/accounts.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's register of connected social accounts.
//
// Deliberately not "one account per platform": she may run @ariana.personal and
// @ariana.creator on Instagram at the same time, each with its own session in
// the engine, its own permission switch, and its own activity trail. Every
// social tool call names the account it acts through, and the brain is told
// which accounts exist so it can choose — the same way a person decides which
// of their accounts to post from.
//
// What lives here: identity + creator permission + last known status.
// What does NOT live here: passwords, cookies, tokens. Sessions are held by the
// engine only (see social/engine_client.js).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const caps = require('./capabilities');
const store = require('./store');

// account status values
const STATUS = {
  NOT_CONNECTED: 'not_connected', // no session on the engine yet
  ONLINE: 'online',               // session verified working
  ERROR: 'error',                 // session invalid / expired / verification failed
  UNKNOWN: 'unknown',             // never checked, or engine unreachable
};

let cache = null; // [{ account_id, platform, handle, label, actions_enabled, status, status_detail, last_checked }]

function makeId(platform, handle) {
  return `${platform}:${String(handle || '').trim().toLowerCase().replace(/^@/, '')}`;
}

function cleanHandle(handle) {
  return String(handle || '').trim().replace(/^@/, '').replace(/\/+$/, '');
}

async function hydrate(force = false) {
  if (cache && !force) return cache;
  const rows = await store.loadAccounts();
  cache = rows.map((r) => ({
    account_id: r.account_id,
    platform: r.platform,
    handle: r.handle,
    label: r.label || null,
    provider: r.provider || 'socialcrabs',
    actions_enabled: !!r.actions_enabled,
    // Only meaningful on platforms that can publish: when on, Ariana may post
    // without a per-post confirmation. Off unless the creator turns it on.
    autopublish: !!r.autopublish,
    status: r.status || STATUS.UNKNOWN,
    status_detail: r.status_detail || null,
    last_checked: r.last_checked || null,
    created_at: r.created_at || null,
  }));
  return cache;
}

function invalidate() { cache = null; }

async function persist(account) {
  // Keep Supabase/file copies in step with the in-memory cache. Status fields
  // are cache-worthy (they drive the dashboard) but never authoritative — the
  // engine is asked directly before anything is shown as "Connected".
  await store.saveAccount(account);
}

async function list() {
  const accounts = await hydrate();
  return accounts.map((a) => ({ ...a }));
}

async function get(accountId) {
  const accounts = await hydrate();
  return accounts.find((a) => a.account_id === accountId) || null;
}

async function add({ platform, handle, label = null, actionsEnabled = false }) {
  const platformId = String(platform || '').toLowerCase().trim();
  if (!caps.platformIds().includes(platformId)) {
    return { ok: false, error: `Unknown platform "${platform}". Supported: ${caps.platformIds().join(', ')}. A platform with no adapter in the engine cannot be connected.` };
  }
  const clean = cleanHandle(handle);
  if (!clean) return { ok: false, error: 'A handle is required — the account Ariana should act as.' };

  const account_id = makeId(platformId, clean);
  const accounts = await hydrate();
  if (accounts.some((a) => a.account_id === account_id)) {
    return { ok: false, error: `${caps.platformInfo(platformId).label} @${clean} is already in the list.` };
  }

  const account = {
    account_id,
    platform: platformId,
    handle: clean,
    label: label || (caps.platformInfo(platformId).label + ' @' + clean),
    provider: 'socialcrabs',
    actions_enabled: !!actionsEnabled,
    autopublish: false,
    status: STATUS.NOT_CONNECTED,
    status_detail: 'No session on the engine yet — provision one to connect.',
    last_checked: null,
    created_at: new Date().toISOString(),
  };
  accounts.push(account);
  cache = accounts;
  await persist(account);
  return { ok: true, account: { ...account } };
}

async function remove(accountId) {
  const accounts = await hydrate();
  const idx = accounts.findIndex((a) => a.account_id === accountId);
  if (idx === -1) return { ok: false, error: 'Account not found.' };
  const [removed] = accounts.splice(idx, 1);
  cache = accounts;
  await store.deleteAccount(accountId);
  return { ok: true, account: removed };
}

async function setActionsEnabled(accountId, enabled) {
  const account = await get(accountId);
  if (!account) return { ok: false, error: 'Account not found.' };
  account.actions_enabled = !!enabled;
  await persist(account);
  return { ok: true, account: { ...account } };
}

// Records the outcome of a session check (engine is the judge, this is the cache).
async function setAutopublish(accountId, enabled) {
  const account = await get(accountId);
  if (!account) return { ok: false, error: 'Account not found.' };
  account.autopublish = !!enabled;
  await persist(account);
  return { ok: true, account: { ...account } };
}

async function setStatus(accountId, status, detail = null) {
  const account = await get(accountId);
  if (!account) return null;
  account.status = status;
  account.status_detail = detail;
  account.last_checked = new Date().toISOString();
  await persist(account);
  return { ...account };
}

// ── RESOLUTION ──────────────────────────────────────────────────────────────
// A tool call can name an account by id ("instagram:ariana.personal"), by bare
// handle ("ariana.personal"), or not at all. Never silently guess between two
// accounts on the same platform — that is exactly how the wrong account ends up
// posting something.
async function resolve(ref, platform = null) {
  const accounts = await hydrate();
  if (!accounts.length) {
    return { ok: false, code: 'no_accounts', error: 'No social accounts are connected yet — add one in the dashboard first.' };
  }

  if (ref) {
    const needle = String(ref).trim().toLowerCase().replace(/^@/, '');
    const byId = accounts.filter((a) => a.account_id.toLowerCase() === needle);
    if (byId.length === 1) return { ok: true, account: byId[0] };

    const byHandle = accounts.filter((a) => a.handle.toLowerCase() === needle || a.handle.toLowerCase().includes(needle));
    const scoped = platform ? byHandle.filter((a) => a.platform === platform) : byHandle;
    if (scoped.length === 1) return { ok: true, account: scoped[0] };
    if (scoped.length > 1) {
      return { ok: false, code: 'ambiguous_account', error: `"${ref}" matches more than one account (${scoped.map((a) => a.account_id).join(', ')}). Name the exact account.` };
    }
    return { ok: false, code: 'account_not_found', error: `No connected account matches "${ref}".` };
  }

  const pool = platform ? accounts.filter((a) => a.platform === platform) : accounts;
  if (pool.length === 1) return { ok: true, account: pool[0] };
  if (pool.length === 0) {
    return { ok: false, code: 'account_not_found', error: platform ? `No ${platform} account is connected.` : 'No connected account matches that platform.' };
  }
  return {
    ok: false,
    code: 'account_required',
    error: `Which account? ${pool.map((a) => a.account_id).join(', ')} — say which one to act through.`,
  };
}

// Compact description for Ariana's system prompt. Only what she needs to choose
// an account: platform, handle, and whether the creator has enabled actions.
async function describeForPrompt() {
  const accounts = await list();
  if (!accounts.length) return null;
  const lines = accounts.map((a) => {
    const label = caps.platformInfo(a.platform)?.label || a.platform;
    const state = !a.actions_enabled
      ? 'actions disabled by your creator'
      : a.status === STATUS.ONLINE
        ? 'connected'
        : a.status === STATUS.ERROR
          ? `not usable right now (${a.status_detail || 'session problem'})`
          : 'connection not verified';
    return `- ${label} @${a.handle} (account_id: ${a.account_id}) — ${state}`;
  });
  return lines.join('\n');
}

module.exports = {
  STATUS,
  makeId,
  hydrate,
  invalidate,
  list,
  get,
  add,
  remove,
  setActionsEnabled,
  setAutopublish,
  setStatus,
  resolve,
  describeForPrompt,
};
