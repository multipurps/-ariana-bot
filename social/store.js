// social/store.js
// ─────────────────────────────────────────────────────────────────────────────
// Where the social layer keeps its small amount of state: the account register,
// the creator's permission switches, the autonomy config, and the activity log.
//
// Two backends, chosen automatically:
//   · Supabase, when Ariana's SUPABASE_URL + service key are configured — the
//     same database that already holds her memories, so accounts and activity
//     survive redeploys;
//   · otherwise JSON files under SOCIAL_DATA_DIR (default ./social_data), which
//     is git-ignored. On a host with an ephemeral disk that means the register
//     resets on redeploy — the log says so at startup rather than pretending.
//
// Sessions are NOT stored here. They live in the engine (socialcrabs-service),
// encrypted, and are never written to Ariana's database or disk.
//
// Required Supabase tables (create once — see SOCIAL.md):
//   ariana_social_accounts, ariana_social_activity, ariana_social_config
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = process.env.SOCIAL_DATA_DIR || path.join(__dirname, '..', 'social_data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ACTIVITY_MAX_LINES = 2000;

let supabase = null;
let supabaseTried = false;
let warnedNoTable = false;

function init() {
  if (supabaseTried) return supabase;
  supabaseTried = true;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_ANON_KEY
      || process.env.SUPABASE_KEY;
    if (process.env.SUPABASE_URL && key) {
      supabase = createClient(process.env.SUPABASE_URL, key, {
        auth: { persistSession: false },
        realtime: { transport: require('ws') },
      });
      console.log('[social] state: Supabase (ariana_social_*)');
    } else {
      console.log(`[social] state: local files in ${DATA_DIR} (set SUPABASE_URL + service key to persist across redeploys)`);
    }
  } catch (e) {
    console.warn('[social] Supabase unavailable, using local files:', e.message);
  }
  return supabase;
}

function usingSupabase() {
  return !!init();
}

function tableMissing(error) {
  const msg = (error && (error.message || error.hint || '')) || '';
  return /does not exist|Could not find the table|relation .* does not exist|schema cache/i.test(msg);
}

function tableWarning(error) {
  if (warnedNoTable) return;
  warnedNoTable = true;
  console.warn(
    `[social] Supabase table missing (${(error && error.message) || 'unknown'}). ` +
    'Falling back to local files for this run. See SOCIAL.md → Supabase tables for the SQL to create ' +
    'ariana_social_accounts / ariana_social_activity / ariana_social_config.'
  );
}

// ── FILE HELPERS ────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const writeChains = new Map(); // file -> promise, keeps writes ordered inside one process
function queueWrite(file, fn) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(file, next);
  return next;
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  ensureDir();
  return queueWrite(file, async () => {
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  });
}

// ── ACCOUNTS ────────────────────────────────────────────────────────────────

async function loadAccounts() {
  const sb = init();
  if (sb) {
    const { data, error } = await sb.from('ariana_social_accounts').select('*').order('created_at', { ascending: true });
    if (!error) return data || [];
    if (!tableMissing(error)) console.warn('[social] loadAccounts failed:', error.message);
    else tableWarning(error);
  }
  return readJsonFile(ACCOUNTS_FILE, []);
}

async function saveAccount(account) {
  const sb = init();
  if (sb) {
    const { error } = await sb.from('ariana_social_accounts').upsert({
      account_id: account.account_id,
      platform: account.platform,
      handle: account.handle,
      label: account.label,
      provider: account.provider,
      actions_enabled: account.actions_enabled,
      status: account.status,
      status_detail: account.status_detail,
      last_checked: account.last_checked,
      created_at: account.created_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });
    if (error && tableMissing(error)) tableWarning(error);
  }
  const rows = await readJsonFile(ACCOUNTS_FILE, []);
  const idx = rows.findIndex((r) => r.account_id === account.account_id);
  if (idx === -1) rows.push(account);
  else rows[idx] = account;
  await writeJsonFile(ACCOUNTS_FILE, rows);
  return account;
}

async function deleteAccount(accountId) {
  const sb = init();
  if (sb) {
    const { error } = await sb.from('ariana_social_accounts').delete().eq('account_id', accountId);
    if (error && tableMissing(error)) tableWarning(error);
  }
  const rows = await readJsonFile(ACCOUNTS_FILE, []);
  await writeJsonFile(ACCOUNTS_FILE, rows.filter((r) => r.account_id !== accountId));
}

// ── ACTIVITY ────────────────────────────────────────────────────────────────

async function appendActivity(entry) {
  const sb = init();
  if (sb) {
    const { error } = await sb.from('ariana_social_activity').insert({
      account_id: entry.account_id,
      platform: entry.platform,
      handle: entry.handle,
      action: entry.action,
      target: entry.target,
      target_handle: entry.target_handle,
      status: entry.status,
      error: entry.error,
      actor: entry.actor,
      summary: entry.summary,
      detail: entry.detail || null,
      duration_ms: entry.duration_ms,
      created_at: entry.created_at,
    });
    if (error && tableMissing(error)) tableWarning(error);
    else return entry;
  }
  ensureDir();
  return queueWrite(ACTIVITY_FILE, async () => {
    await fsp.appendFile(ACTIVITY_FILE, JSON.stringify(entry) + '\n');
    // keep the file from growing without bound; the newest lines are the truth
    try {
      const content = await fsp.readFile(ACTIVITY_FILE, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > ACTIVITY_MAX_LINES) {
        await fsp.writeFile(ACTIVITY_FILE, lines.slice(-ACTIVITY_MAX_LINES).join('\n') + '\n');
      }
    } catch (_) {}
  }).then(() => entry);
}

async function loadActivity(limit = 50, accountId = null) {
  const sb = init();
  if (sb) {
    let q = sb.from('ariana_social_activity').select('*').order('created_at', { ascending: false }).limit(limit);
    if (accountId) q = q.eq('account_id', accountId);
    const { data, error } = await q;
    if (!error) return data || [];
    if (!tableMissing(error)) console.warn('[social] loadActivity failed:', error.message);
    else tableWarning(error);
  }
  try {
    const content = await fsp.readFile(ACTIVITY_FILE, 'utf8');
    let rows = content.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
    if (accountId) rows = rows.filter((r) => r.account_id === accountId);
    return rows.slice(-limit).reverse();
  } catch (_) {
    return [];
  }
}

// ── CONFIG (autonomy) ───────────────────────────────────────────────────────

async function loadConfig() {
  const sb = init();
  if (sb) {
    const { data, error } = await sb.from('ariana_social_config').select('config').eq('id', 'default').maybeSingle();
    if (!error && data && data.config) return data.config;
    if (error && !tableMissing(error)) console.warn('[social] loadConfig failed:', error.message);
    else if (error) tableWarning(error);
  }
  return readJsonFile(CONFIG_FILE, {});
}

async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...(patch || {}), updated_at: new Date().toISOString() };
  const sb = init();
  if (sb) {
    const { error } = await sb.from('ariana_social_config').upsert({ id: 'default', config: next, updated_at: next.updated_at }, { onConflict: 'id' });
    if (error && tableMissing(error)) tableWarning(error);
  }
  await writeJsonFile(CONFIG_FILE, next);
  return next;
}

module.exports = {
  DATA_DIR,
  usingSupabase,
  loadAccounts,
  saveAccount,
  deleteAccount,
  appendActivity,
  loadActivity,
  loadConfig,
  saveConfig,
};
