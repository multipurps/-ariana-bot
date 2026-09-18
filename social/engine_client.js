// social/engine_client.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's HTTP client for the social engine (socialcrabs-service/).
//
// Architecture note — why this is a service and not a require():
// SocialCrabs drives real browsers (Playwright + Chromium) and keeps long-lived
// login sessions on disk. That belongs in its own always-on process, not inside
// Ariana's reply path: a browser crash, a Chromium upgrade or a heavy render
// must never be able to take her brain down, and the engine needs its own
// persistent volume for sessions. So Ariana talks to it over HTTP with a
// shared API key, and this file is the only place that knows the wire format.
//
// Every function returns { ok: true, ... } or { ok: false, error, code } and
// never throws — a dead engine must degrade to "Backend not connected", not to
// a broken conversation.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const DEFAULT_TIMEOUT_MS = 120000; // browser actions are slow on purpose (human delays)

function baseUrl() {
  const raw = (process.env.SOCIAL_ENGINE_URL || '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function apiKey() {
  return (process.env.SOCIAL_ENGINE_API_KEY || '').trim() || null;
}

function configured() {
  return !!baseUrl();
}

function configHint() {
  return 'Set SOCIAL_ENGINE_URL (and SOCIAL_ENGINE_API_KEY) to the address of your deployed social engine.';
}

async function request(method, urlPath, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = baseUrl();
  if (!base) {
    return { ok: false, error: 'Social engine not connected — ' + configHint(), code: 'not_configured' };
  }
  const headers = { 'Content-Type': 'application/json' };
  const key = apiKey();
  if (key) headers['X-Api-Key'] = key;

  try {
    const res = await fetch(base + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'The social engine rejected the API key — check SOCIAL_ENGINE_API_KEY matches the engine.', code: 'unauthorized', status: res.status };
    }
    if (res.status === 404) {
      return { ok: false, error: (data && (data.error || data.message)) || `The engine has no ${method} ${urlPath} route.`, code: 'not_found', status: 404 };
    }
    if (!res.ok) {
      // The engine answers failures with its own code (session_expired,
      // no_session, unsupported, browser_limit…). Keep it: the activity log and
      // Ariana's wording both depend on knowing which failure this was.
      return {
        ok: false,
        code: (data && data.code) || 'engine_error',
        error: (data && (data.error || data.message)) || `Engine returned HTTP ${res.status}.`,
        status: res.status,
        data,
      };
    }
    return { ok: true, data };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false,
      code: timedOut ? 'timeout' : 'unreachable',
      error: timedOut
        ? `The social engine did not answer within ${Math.round(timeoutMs / 1000)}s — the browser action may still be running.`
        : `Cannot reach the social engine at ${base} (${e.message}).`,
    };
  }
}

// ── STATUS ──────────────────────────────────────────────────────────────────

async function health({ timeoutMs = 10000 } = {}) {
  const r = await request('GET', '/health', undefined, { timeoutMs });
  if (!r.ok) return r;
  return { ok: true, health: r.data };
}

async function capabilities() {
  const r = await request('GET', '/api/capabilities', undefined, { timeoutMs: 15000 });
  if (!r.ok) return r;
  return { ok: true, capabilities: r.data };
}

// Engine-side view of every session it holds. Used to reconcile statuses.
async function sessions() {
  const r = await request('GET', '/api/sessions', undefined, { timeoutMs: 15000 });
  if (!r.ok) return r;
  return { ok: true, sessions: r.data.sessions || [] };
}

// ── SESSION LIFECYCLE ───────────────────────────────────────────────────────

async function sessionStatus(account) {
  const r = await request('GET', `/api/sessions/${encodeURIComponent(account.account_id)}?platform=${encodeURIComponent(account.platform || '')}`, undefined, { timeoutMs: 20000 });
  if (!r.ok) return r;
  return { ok: true, session: r.data };
}

// Opens the platform in a browser and asks "am I logged in?" — the difference
// between "a session file exists" and "the session works".
async function verify(account) {
  const r = await request('POST', `/api/sessions/${encodeURIComponent(account.account_id)}/verify`, {
    platform: account.platform,
    handle: account.handle,
  }, { timeoutMs: 180000 });
  if (!r.ok) return r;
  return { ok: true, session: r.data };
}

// Server-to-server session provisioning. Used by the local login helper and by
// ops scripts — never by the dashboard. The dashboard has no route that accepts
// credentials or cookies; this is called from the operator's own machine.
async function importSession(account, session) {
  const r = await request('POST', `/api/sessions/${encodeURIComponent(account.account_id)}/import`, {
    platform: account.platform,
    handle: account.handle,
    session,
  }, { timeoutMs: 60000 });
  if (!r.ok) return r;
  return { ok: true, result: r.data };
}

async function disconnect(account) {
  const r = await request('DELETE', `/api/sessions/${encodeURIComponent(account.account_id)}?platform=${encodeURIComponent(account.platform || '')}`, undefined, { timeoutMs: 60000 });
  if (!r.ok) return r;
  return { ok: true, result: r.data };
}

// ── ACTIONS ─────────────────────────────────────────────────────────────────

// payload is the action's platform payload: { url } | { url, text } |
// { username } | { username, message } | { text } | { query } | { profileUrl, note }
async function act(account, action, payload, { timeoutMs = 180000 } = {}) {
  const r = await request('POST', `/api/accounts/${encodeURIComponent(account.account_id)}/actions/${encodeURIComponent(action)}`, {
    platform: account.platform,
    handle: account.handle,
    payload,
  }, { timeoutMs });
  if (!r.ok) return r;

  const result = r.data && r.data.result ? r.data.result : r.data;
  if (!result || result.success !== true) {
    return {
      ok: false,
      code: (result && result.code) || 'action_failed',
      error: (result && result.error) || (r.data && r.data.error) || 'The engine did not report success for that action.',
      result: result || null,
    };
  }
  return { ok: true, result };
}

module.exports = {
  configured,
  configHint,
  baseUrl,
  apiKey,
  health,
  capabilities,
  sessions,
  sessionStatus,
  verify,
  importSession,
  disconnect,
  act,
};
