// social/api.js
// ─────────────────────────────────────────────────────────────────────────────
// The dashboard's side of the social layer.
//
// Mounted by index.js behind the same `requireDashboardAuth` that guards
// /api/owner-command and /api/talk — connecting an account or firing an action
// is exactly as sensitive as those, so it gets the same gate. When
// DASHBOARD_SECRET is not set the whole dashboard is open (that is Ariana's
// existing behaviour), which is why SOCIAL.md tells you to set it.
//
// Nothing here accepts a password. There is no field, route or parameter that
// carries platform credentials — sessions are provisioned server-side in the
// engine (see SOCIAL.md → Connecting an account).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const caps = require('./capabilities');
const accounts = require('./accounts');
const activity = require('./activity');
const guards = require('./guards');
const tools = require('./tools');
const engine = require('./engine_client');
const autonomy = require('./autonomy');

function ok(res, data) { res.json({ ok: true, ...data }); }
function fail(res, status, error, extra = {}) { res.status(status).json({ ok: false, error, ...extra }); }

// Where to send someone who wants to actually log the account in. Kept in one
// place so the dashboard, the docs and the error messages never drift.
function provisioningSteps(platform) {
  const label = caps.platformLabel(platform);
  const info = caps.platformInfo(platform) || {};
  const steps = [
    `1. On the machine where the engine runs, provision the session: node scripts/connect-session.js --platform ${platform} --handle <your handle> --engine <engine url> --key <engine api key>.`,
    '2. That script opens the platform in a real browser so the login happens on the platform\'s own page — the password is typed there, never into Ariana.',
    '3. It sends only the resulting session to the engine, which stores it encrypted. Nothing is saved in Ariana and nothing is committed to git.',
    '4. Come back here and press Connect — Ariana verifies the session live and shows Connected once it really works.',
  ];
  if (info.env_bootstrap) {
    steps.splice(1, 0, `Alternative for ${label}: set ${(info.env_bootstrap_vars || []).join(' and ')} on the engine (two cookies from a logged-in browser) and skip the helper script.`);
  }
  return {
    platform,
    needs_session: true,
    steps,
    note: 'There is no way to paste a password into Ariana\'s dashboard by design. If you would rather do it by hand, the helper script is the only path — see SOCIAL.md.',
  };
}

function attach(app, { requireAuth } = {}) {
  const r = express.Router();
  const guard = requireAuth || ((req, res, next) => next());

  const withCapabilities = (a) => ({
    ...a,
    capabilities: {
      supported: caps.supportedActions(a.platform),
      unsupported: caps.unsupportedActions(a.platform),
    },
  });

  // ── STATUS ──────────────────────────────────────────────────────────────
  r.get('/status', guard, async (_req, res) => {
    const [list, health] = await Promise.all([
      accounts.list(),
      engine.configured() ? engine.health() : Promise.resolve({ ok: false, code: 'not_configured', error: 'Social engine not connected — ' + engine.configHint() }),
    ]);
    const autonomyCfg = await autonomy.getConfig();
    ok(res, {
      engine: {
        configured: engine.configured(),
        url: engine.baseUrl(),
        reachable: !!health.ok,
        error: health.ok ? null : health.error,
        health: health.ok ? health.health : null,
      },
      storage: { supabase: store_UsesSupabase(), data_dir: storeDataDir() },
      accounts: list.map((a) => ({
        account_id: a.account_id, platform: a.platform, handle: a.handle,
        actions_enabled: a.actions_enabled, status: a.status, status_detail: a.status_detail,
        last_checked: a.last_checked,
      })),
      autonomy: { enabled: !!autonomyCfg.enabled, interval_minutes: autonomyCfg.interval_minutes, ...autonomy.status() },
      dry_run: process.env.SOCIAL_DRY_RUN === '1',
      setup: engine.configured() ? null : setupInstructions(),
    });
  });

  function store_UsesSupabase() { try { return require('./store').usingSupabase(); } catch (_) { return false; } }
  function storeDataDir() { try { return require('./store').DATA_DIR; } catch (_) { return null; } }

  function setupInstructions() {
    return {
      engine_url: engine.baseUrl(),
      engine_configured: engine.configured(),
      steps: [
        '1. Deploy the social engine (socialcrabs-service/) — Railway or Render, Docker, with a persistent volume mounted at /data.',
        '2. Set SOCIAL_ENGINE_API_KEY on the engine and the same value here as SOCIAL_ENGINE_API_KEY, plus SOCIAL_ENGINE_URL pointing at it.',
        '3. Provision a session for each account — run scripts/connect-session.js from the engine folder on your own machine: it opens the real login page in a browser you control, then sends only the resulting session to the engine. Your password never touches Ariana or her dashboard.',
        '4. Back in this dashboard, press Connect on the account to verify the session is live, then enable Actions.',
      ],
      x_env_bootstrap: 'X/Twitter can skip the login helper: set SOCIALCRABS_AUTH_TOKEN and SOCIALCRABS_CT0 on the engine (from a logged-in browser session) and it builds the session itself.',
      volume: 'Sessions live in the engine at SESSION_DIR (default /data/sessions on the container). Mount a volume there or every redeploy logs the accounts out.',
    };
  }

  // ── CAPABILITIES ────────────────────────────────────────────────────────
  // Prefers the live engine's manifest; falls back to the bundled copy so the
  // dashboard can still be honest about what the integration supports while the
  // backend is not connected.
  r.get('/capabilities', guard, async (_req, res) => {
    const live = engine.configured() ? await engine.capabilities() : { ok: false };
    if (live.ok && live.capabilities && live.capabilities.platforms) {
      return ok(res, { source: 'engine', capabilities: live.capabilities, note: 'Reported by the running social engine.' });
    }
    ok(res, {
      source: 'bundled',
      capabilities: caps.describe(),
      note: engine.configured()
        ? 'The engine is unreachable — showing the bundled manifest that ships with Ariana.'
        : 'No engine connected — this is what the integration supports once you deploy one. Nothing can act until then.',
    });
  });

  // ── ACCOUNTS ────────────────────────────────────────────────────────────
  r.get('/accounts', guard, async (_req, res) => {
    const list = await accounts.list();
    const sessions = engine.configured() ? await engine.sessions() : { ok: false };
    const byId = new Map((sessions.sessions || []).map((s) => [s.account_id, s]));
    ok(res, {
      accounts: list.map((a) => ({
        ...withCapabilities(a),
        engine_session: sessions.ok ? (byId.get(a.account_id) || { connected: false, detail: 'No session on the engine yet.' }) : { reachable: false, detail: sessions.error },
      })),
    });
  });

  r.post('/accounts', guard, async (req, res) => {
    const { platform, handle, label } = req.body || {};
    const result = await accounts.add({ platform, handle, label });
    if (!result.ok) return fail(res, 400, result.error);
    ok(res, { account: withCapabilities(result.account) });
  });

  r.delete('/accounts/:id', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (engine.configured()) await engine.disconnect(account);
    const removed = await accounts.remove(req.params.id);
    ok(res, { account: removed.account });
  });

  // Connect = verify the session that was provisioned server-side, and report
  // exactly what the engine says. Never asks the browser for anything.
  r.post('/accounts/:id/connect', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (!engine.configured()) {
      return fail(res, 503, 'Social engine not connected — ' + engine.configHint(), { setup: setupInstructions() });
    }

    // Cheap check first: is there a session at all? Only run the browser if so —
    // an empty slot must not cost a minute of Chromium to discover.
    const status = await engine.sessionStatus(account);
    if (!status.ok) {
      const updated = await accounts.setStatus(account.account_id, accounts.STATUS.UNKNOWN, status.error);
      return fail(res, 502, status.error, { account: updated });
    }
    const s = status.session || {};
    if (!s.exists && !s.has_session) {
      const updated = await accounts.setStatus(account.account_id, accounts.STATUS.NOT_CONNECTED, 'No session on the engine yet — provision one, then Connect again.');
      return ok(res, { account: updated, connected: false, provisioning: provisioningSteps(account.platform) });
    }

    const verified = await engine.verify(account);
    if (!verified.ok) {
      const updated = await accounts.setStatus(account.account_id, accounts.STATUS.ERROR, verified.error);
      return fail(res, 502, verified.error, { account: updated });
    }
    const v = verified.session || {};
    if (v.connected) {
      const updated = await accounts.setStatus(account.account_id, accounts.STATUS.ONLINE, v.detail || 'Session verified live in the browser.');
      return ok(res, { account: updated, connected: true });
    }
    const updated = await accounts.setStatus(account.account_id, accounts.STATUS.ERROR, v.detail || v.error || 'The platform says this session is not logged in.');
    ok(res, { account: updated, connected: false, needs_reconnect: true, error: v.error || null });
  });

  r.post('/accounts/:id/disconnect', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (!engine.configured()) return fail(res, 503, 'Social engine not connected — nothing to disconnect.');
    const out = await engine.disconnect(account);
    const updated = await accounts.setStatus(account.account_id, accounts.STATUS.NOT_CONNECTED, out.ok ? 'Session deleted from the engine.' : out.error);
    if (!out.ok) return fail(res, 502, out.error, { account: updated });
    ok(res, { account: updated });
  });

  r.post('/accounts/:id/enable', guard, async (req, res) => {
    const out = await accounts.setActionsEnabled(req.params.id, true);
    if (!out.ok) return fail(res, 404, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  r.post('/accounts/:id/disable', guard, async (req, res) => {
    const out = await accounts.setActionsEnabled(req.params.id, false);
    if (!out.ok) return fail(res, 404, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  // Publishing is the one action with an extra creator switch, because it is
  // public and permanent. Off by default; only meaningful where posting exists.
  r.post('/accounts/:id/autopublish', guard, async (req, res) => {
    const account = await accounts.get(req.params.id);
    if (!account) return fail(res, 404, 'That account is not in the list.');
    if (!caps.supports(account.platform, 'post')) {
      return fail(res, 422, caps.unsupportedReason(account.platform, 'post') || `${caps.platformLabel(account.platform)} cannot publish through this integration.`);
    }
    const out = await accounts.setAutopublish(req.params.id, !!(req.body || {}).enabled);
    if (!out.ok) return fail(res, 400, out.error);
    ok(res, { account: withCapabilities(out.account) });
  });

  // ── ACTIVITY ────────────────────────────────────────────────────────────
  r.get('/activity', guard, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const account = req.query.account || null;
    ok(res, { activity: await activity.recent(limit, account) });
  });

  // ── CONFIRMATIONS ───────────────────────────────────────────────────────
  // A human in the dashboard mints a short-lived, single-use token; the guarded
  // action consumes it. Ariana cannot mint her own confirmations.
  r.get('/confirmations', guard, async (_req, res) => {
    ok(res, { confirmations: guards.listConfirmations(), ttl_ms: guards.CONFIRM_TTL_MS, batch_max: guards.BATCH_MAX });
  });

  r.post('/confirmations', guard, async (req, res) => {
    const { account_id, action, max_targets, note } = req.body || {};
    if (!action) return fail(res, 400, 'An action is required.');
    ok(res, guards.createConfirmation({ accountId: account_id, action, maxTargets: max_targets, note }));
  });

  // ── ACTIONS (manual, creator-driven) ────────────────────────────────────
  // Same executor Ariana uses. Available so the creator can test an action
  // end-to-end, or do something themselves through her accounts.
  r.post('/actions/:action', guard, async (req, res) => {
    const action = String(req.params.action || '').toLowerCase();
    const tool = tools.TOOL_FOR_ACTION[action];
    if (!tool) return fail(res, 404, `"${action}" is not an action Ariana can take. Known actions: ${Object.keys(tools.TOOL_FOR_ACTION).join(', ')}.`);
    const body = req.body || {};
    const result = await tools.executeTool(tool.name, body, {
      source: 'dashboard',
      actor: 'creator',
      accountHint: body.account || null,
      confirmationToken: body.confirmation_token || null,
    });
    if (!result.ok) {
      const status = result.code === 'not_configured' ? 503
        : result.code === 'unsupported' || result.code === 'unsupported_platform' ? 422
        : result.code === 'needs_confirmation' ? 409
        : 400;
      return res.status(status).json(result);
    }
    ok(res, { result });
  });

  // ── AUTONOMY ────────────────────────────────────────────────────────────
  r.get('/autonomy', guard, async (_req, res) => {
    ok(res, { autonomy: await autonomy.getConfig(), runtime: autonomy.status() });
  });

  r.post('/autonomy', guard, async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    ['interval_minutes', 'max_actions_per_tick', 'max_candidates_per_tick'].forEach((k) => {
      if (body[k] != null) patch[k] = Math.max(1, parseInt(body[k], 10) || undefined);
    });
    ['allow_comment', 'allow_follow'].forEach((k) => { if (typeof body[k] === 'boolean') patch[k] = body[k]; });
    if (body.watchlist && typeof body.watchlist === 'object') {
      patch.watchlist = {
        instagram: Array.isArray(body.watchlist.instagram) ? body.watchlist.instagram.map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean).slice(0, 10) : [],
      };
    }
    if (Array.isArray(body.linkedin_searches)) {
      patch.linkedin_searches = body.linkedin_searches.map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
    }
    const next = await autonomy.setConfig(patch);
    ok(res, { autonomy: next });
  });

  r.post('/autonomy/run', guard, async (_req, res) => {
    ok(res, await autonomy.runOnce({ trigger: 'manual' }));
  });

  app.use('/api/social', r);
  return r;
}

module.exports = { attach, provisioningSteps };
