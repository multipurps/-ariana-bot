// socialcrabs-service/src/engine.js
// ─────────────────────────────────────────────────────────────────────────────
// The engine core: one SocialCrabs runtime per ACCOUNT, the dispatch table that
// turns canonical actions into real platform calls, and the session plumbing
// that keeps logins encrypted at rest.
//
// Why one runtime per account: SocialCrabs keys its browser contexts by
// platform only (one Instagram session per process). Ariana may hold several
// accounts on the same platform, so each account gets its own runtime, its own
// session directory and its own rate-limit file. Nothing about one account can
// leak into another.
//
// The dispatch table is the adapter layer. Adding a platform later means adding
// its handler here plus manifest entries — Ariana's brain, tools and dashboard
// stay exactly as they are.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const caps = require('./capabilities');
const vault = require('./session-vault');

const READ_ACTIONS = new Set(['search', 'view_profile', 'view_posts', 'view_feed', 'notifications', 'engagement', 'read_dms']);

// Canonical action → platform method. Payload keys come from the manifest's
// `requires`; the shapes below match the handlers in SocialCrabs 0.0.49.
const DISPATCH = {
  instagram: {
    like: (h, p) => h.like({ url: p.url }),
    comment: (h, p) => h.comment({ url: p.url, text: p.text }),
    follow: (h, p) => h.follow({ username: p.username }),
    unfollow: (h, p) => h.unfollow({ username: p.username }),
    dm: (h, p) => h.dm({ username: p.username, message: p.message }),
    view_profile: (h, p) => h.getProfile(p.username),
    engagement: (h, p) => h.getProfile(p.username),
    view_posts: (h, p) => h.getRecentPosts(p.username, Math.min(Number(p.limit) || 3, 5)),
  },
  twitter: {
    like: (h, p) => h.like({ url: p.url }),
    comment: (h, p) => h.comment({ url: p.url, text: p.text }),
    reply: (h, p) => h.comment({ url: p.url, text: p.text }),
    follow: (h, p) => h.follow({ username: p.username }),
    unfollow: (h, p) => h.unfollow({ username: p.username }),
    dm: (h, p) => h.dm({ username: p.username, message: p.message }),
    post: (h, p) => h.post({ text: p.text }),
    repost: (h, p) => h.retweet(p.url),
    view_profile: (h, p) => h.getProfile(p.username),
    engagement: (h, p) => h.getProfile(p.username),
  },
  linkedin: {
    search: (h, p) => h.search(p.query),
    like: (h, p) => h.like({ url: p.url }),
    comment: (h, p) => h.comment({ url: p.url, text: p.text }),
    follow: (h, p) => h.follow({ username: p.username }),
    unfollow: (h, p) => h.unfollow({ username: p.username }),
    connect: (h, p) => h.connect({ profileUrl: p.profileUrl, note: p.note }),
    dm: (h, p) => h.dm({ username: p.username, message: p.message }),
    view_profile: (h, p) => h.getProfile(p.username),
    engagement: (h, p) => h.getProfile(p.username),
  },
};

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The default runtime is the real thing: SocialCrabs, loaded lazily so the
// engine can boot (and report honest errors) even before its dependency is
// installed.
//
// The factory contract is deliberately narrow — `({ accountId, platform, config })
// → runtime instance` (async allowed), where the instance has initialize(),
// shutdown(), a handler per platform and a browserManager. Tests inject a fake
// with exactly that shape, so everything except the browser can be verified
// without a browser.
// Errors bubble up to the dashboard and the activity log, where a multi-line
// `require` stack is noise — the creator needs the one sentence that says what
// to do. Everything before the stack is kept; the stack is not.
function oneLine(error) {
  const raw = (error && error.message) || String(error || 'Unknown error');
  return raw.split('\n').filter((l) => !/^\s*(-|Require stack:|at |Node\.js)/.test(l)).join(' ').trim();
}

async function defaultRuntimeFactory({ config } = {}) {
  let SocialCrabs;
  try {
    ({ SocialCrabs } = require('socialcrabs'));
  } catch (e) {
    const err = new Error(
      'SocialCrabs is not installed in this deployment. Run "npm install" in socialcrabs-service/ ' +
      '(it is a GitHub dependency), then "npm run build:socialcrabs". Underlying error: ' + oneLine(e)
    );
    err.code = 'runtime_missing';
    throw err;
  }
  return new SocialCrabs(config);
}

class SocialEngine {
  constructor(options = {}) {
    this.factory = options.runtimeFactory || defaultRuntimeFactory;
    this.logger = options.logger || console;
    this.maxBrowsers = envInt('MAX_BROWSERS', 2);
    this.idleMs = envInt('IDLE_SHUTDOWN_MINUTES', 20) * 60 * 1000;
    this.actionGapMs = envInt('ACTION_GAP_MS', 10000);
    this.runtimes = new Map(); // accountId -> runtime record
    this.startedAt = Date.now();
    this.sweeper = null;
  }

  log(level, msg, meta) {
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    const fn = typeof this.logger[level] === 'function' ? this.logger[level].bind(this.logger) : this.logger.log.bind(this.logger);
    fn(`[engine] ${line}`);
  }

  // ── RUNTIMES ──────────────────────────────────────────────────────────────

  runtime(accountId, platform, handle) {
    let rt = this.runtimes.get(accountId);
    if (!rt) {
      rt = {
        accountId,
        platform,
        handle: handle || null,
        client: null,
        starting: null,
        lastUsedAt: 0,
        verifiedAt: 0,
        lastError: null,
        scratchRuntimeDir: vault.scratchDir(accountId),
      };
      this.runtimes.set(accountId, rt);
    }
    if (handle) rt.handle = handle;
    return rt;
  }

  openBrowsers() {
    return [...this.runtimes.values()].filter((rt) => rt.client && rt.clientReady).length;
  }

  // Frees the least recently used browser when the cap is reached. Sessions are
  // synced back before anything closes, so nothing is lost.
  async makeRoom() {
    const open = [...this.runtimes.values()].filter((rt) => rt.client && rt.clientReady);
    if (open.length < this.maxBrowsers) return;
    const victim = open.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    this.log('info', `browser limit (${this.maxBrowsers}) reached — closing the least recently used account`, { account: victim.accountId });
    await this.closeRuntime(victim);
  }

  async ensureClient(rt) {
    if (rt.client && rt.clientReady) return rt.client;
    if (rt.starting) return rt.starting;

    rt.starting = (async () => {
      await this.makeRoom();

      // Materialise the stored session into the scratch runtime dir the library
      // reads from, then let it restore normally.
      const session = vault.load(rt.accountId, rt.platform);
      fs.mkdirSync(rt.scratchRuntimeDir, { recursive: true, mode: 0o700 });
      if (session) {
        vault.materialize(rt.accountId, rt.platform, session);
      } else if (rt.platform !== 'twitter') {
        throw Object.assign(new Error('No session stored for this account. Provision one with scripts/connect-session.js (see SOCIAL.md).'), { code: 'no_session' });
      }

      const client = await this.factory({
        accountId: rt.accountId,
        platform: rt.platform,
        config: {
          server: { port: 0 },
          browser: {
            headless: process.env.BROWSER_HEADLESS !== 'false',
            timeout: envInt('BROWSER_TIMEOUT', 30000),
          },
          session: { dir: rt.scratchRuntimeDir },
          logging: { level: process.env.LOG_LEVEL || 'info' },
          notifications: { enabled: false },
        },
      });
      await client.initialize();
      rt.client = client;
      rt.clientReady = true;
      rt.lastUsedAt = Date.now();
      this.log('info', `runtime ready for ${rt.accountId}`, { headless: process.env.BROWSER_HEADLESS !== 'false' });
      return client;
    })();

    try {
      return await rt.starting;
    } catch (e) {
      rt.lastError = e.message;
      throw e;
    } finally {
      rt.starting = null;
    }
  }

  handlerFor(rt) {
    const client = rt.client;
    if (!client) throw new Error('Runtime not started.');
    const handler = client[rt.platform];
    if (!handler) throw new Error(`The runtime has no handler for ${rt.platform}.`);
    return handler;
  }

  // Persists the browser's current session: ask the library to write it, then
  // encrypt it back into the vault and drop the plaintext file.
  async syncSessionBack(rt) {
    if (!rt.client) return { ok: false, error: 'No runtime to persist.' };
    try {
      const manager = rt.client.browserManager;
      if (manager && typeof manager.saveSession === 'function') {
        await manager.saveSession(rt.platform);
      }
      const file = path.join(rt.scratchRuntimeDir, `${rt.platform}.json`);
      if (!fs.existsSync(file)) return { ok: false, error: 'The runtime did not produce a session file.' };
      const session = JSON.parse(fs.readFileSync(file, 'utf8'));
      const saved = vault.save(rt.accountId, rt.platform, session, { handle: rt.handle });
      return saved.ok ? { ok: true } : { ok: false, error: saved.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async closeRuntime(rt) {
    if (!rt || !rt.client) return;
    try { await this.syncSessionBack(rt); } catch (_) {}
    try { await rt.client.shutdown(); } catch (e) { this.log('warn', `shutdown failed for ${rt.accountId}: ${e.message}`); }
    rt.client = null;
    rt.clientReady = false;
    vault.clearScratch(rt.accountId);
  }

  // ── SESSIONS ──────────────────────────────────────────────────────────────

  sessionStatus({ accountId, platform }) {
    const meta = vault.meta(accountId) || {};
    const exists = vault.exists(accountId);
    const rt = this.runtimes.get(accountId);
    const envBootstrap = platform === 'twitter' && !!(process.env.SOCIALCRABS_AUTH_TOKEN || process.env.AUTH_TOKEN);
    return {
      account_id: accountId,
      platform: platform || meta.platform || null,
      handle: meta.handle || (rt && rt.handle) || null,
      exists,
      has_session: exists,
      env_bootstrap: envBootstrap,
      encrypted: !!vault.key(),
      session_updated_at: meta.updated_at || null,
      browser_open: !!(rt && rt.clientReady),
      verified_at: rt && rt.verifiedAt ? new Date(rt.verifiedAt).toISOString() : null,
      last_error: (rt && rt.lastError) || null,
      connected: !!(rt && rt.verifiedAt && !rt.lastError),
      detail: exists
        ? (rt && rt.lastError ? rt.lastError : 'A session is stored for this account.')
        : 'No session stored on the engine yet.',
    };
  }

  listSessions() {
    const known = new Map();
    for (const row of vault.list()) {
      const meta = row.meta || {};
      known.set(meta.account_id || row.dir, {
        account_id: meta.account_id || row.dir,
        platform: meta.platform || null,
        handle: meta.handle || null,
        has_session: row.has_session,
        session_updated_at: meta.updated_at || null,
      });
    }
    for (const rt of this.runtimes.values()) {
      if (!known.has(rt.accountId)) {
        known.set(rt.accountId, { account_id: rt.accountId, platform: rt.platform, handle: rt.handle, has_session: false, session_updated_at: null });
      }
    }
    return [...known.values()];
  }

  importSession({ accountId, platform, handle, session }) {
    if (!caps.platformInfo(platform)) {
      return { success: false, code: 'unsupported_platform', error: caps.check(platform, 'view_profile').error };
    }
    const result = vault.save(accountId, platform, session, { handle });
    if (!result.ok) return { success: false, code: 'invalid_session', error: result.error };
    // An already-open browser is now holding a stale session — close it so the
    // next action picks the new one up.
    const rt = this.runtimes.get(accountId);
    if (rt && rt.client) {
      this.closeRuntime(rt).catch(() => {});
    }
    return { success: true, session: this.sessionStatus({ accountId, platform }) };
  }

  async disconnect({ accountId }) {
    const rt = this.runtimes.get(accountId);
    if (rt && rt.client) await this.closeRuntime(rt);
    this.runtimes.delete(accountId);
    vault.remove(accountId);
    return { success: true };
  }

  async verify({ accountId, platform, handle }) {
    if (!caps.platformInfo(platform)) {
      return { connected: false, code: 'unsupported_platform', error: caps.check(platform, 'view_profile').error };
    }
    const exists = vault.exists(accountId);
    const envBootstrap = platform === 'twitter' && !!(process.env.SOCIALCRABS_AUTH_TOKEN || process.env.AUTH_TOKEN);
    if (!exists && !envBootstrap) {
      return {
        connected: false,
        exists: false,
        detail: 'No session is stored for this account yet. Provision one with socialcrabs-service/scripts/connect-session.js — see SOCIAL.md.',
      };
    }

    const rt = this.runtime(accountId, platform, handle);
    try {
      await this.ensureClient(rt);
      const handler = this.handlerFor(rt);
      const loggedIn = await handler.isLoggedIn();
      rt.verifiedAt = Date.now();
      rt.lastUsedAt = Date.now();
      const synced = await this.syncSessionBack(rt);
      if (!synced.ok) this.log('warn', `could not refresh session for ${accountId}: ${synced.error}`);
      if (loggedIn) {
        rt.lastError = null;
        return { connected: true, detail: 'Session verified live in the browser.', session: this.sessionStatus({ accountId, platform }) };
      }
      rt.lastError = 'The platform says this session is not logged in — it has probably expired or been revoked.';
      return { connected: false, code: 'session_expired', error: rt.lastError };
    } catch (e) {
      rt.lastError = e.message;
      return { connected: false, code: e.code || 'verify_failed', error: oneLine(e) };
    }
  }

  // ── ACTION PAYLOAD VALIDATION ─────────────────────────────────────────────

  validatePayload(platform, action, payload = {}) {
    const spec = caps.actionSpec(action) || {};
    const entry = caps.entry(platform, action) || {};
    const requires = spec.requires || [];
    const missing = requires.filter((k) => {
      const map = { profile_url: 'profileUrl' };
      const key = map[k] || k;
      const value = payload[key] !== undefined ? payload[key] : payload[k];
      return value === undefined || value === null || String(value).trim() === '';
    });
    if (missing.length) {
      return { ok: false, error: `"${action}" needs ${missing.map((m) => `"${m}"`).join(', ')}.` };
    }
    if (entry.limit_note) return { ok: true };
    return { ok: true };
  }

  // ── ACTIONS ───────────────────────────────────────────────────────────────

  async pace(rt, action) {
    if (READ_ACTIONS.has(action)) return;
    const gap = Math.round(this.actionGapMs * (0.7 + Math.random() * 0.6)); // ±30% jitter
    const since = Date.now() - rt.lastUsedAt;
    if (rt.lastUsedAt && since < gap) {
      await sleep(gap - since);
    }
  }

  // Some handlers return a whole page (LinkedIn search returns { html, posts }).
  // The HTML is useless to Ariana and can be megabytes, so it is replaced by its
  // length — the caller still sees that a page was read, and nothing downstream
  // (activity log, prompt, dashboard) has to carry it.
  scrubResult(value, depth = 0) {
    if (typeof value === 'string') {
      return value.length > 4000 ? `${value.slice(0, 4000)}…[truncated]` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => this.scrubResult(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'html' && typeof v === 'string') {
          out.html_chars = v.length;
          continue;
        }
        out[k] = this.scrubResult(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  // Normalises whatever a handler returned into the engine's one result shape.
  normalizeResult(platform, action, target, raw, startedAt) {
    const duration = Date.now() - startedAt;
    if (raw && typeof raw === 'object' && typeof raw.success === 'boolean') {
      return {
        success: raw.success,
        platform,
        action,
        target: raw.target || target || null,
        message: raw.message || null,
        error: raw.error || null,
        code: raw.success ? null : (raw.code || 'action_failed'),
        duration,
        data: raw.data === undefined ? undefined : this.scrubResult(raw.data),
      };
    }
    return { success: true, platform, action, target: target || null, duration, data: raw === undefined ? null : this.scrubResult(raw) };
  }

  async act({ accountId, platform, handle, action, payload = {} }) {
    const started = Date.now();

    const cap = caps.check(platform, action);
    if (!cap.ok) return { success: false, code: cap.code, error: cap.error, platform, action };

    const validator = this.validatePayload(platform, action, payload);
    if (!validator.ok) return { success: false, code: 'invalid_payload', error: validator.error, platform, action };

    const dispatch = (DISPATCH[platform] || {})[action];
    if (typeof dispatch !== 'function') {
      return { success: false, code: 'not_implemented', error: `"${action}" is declared for ${platform} but the engine has no handler for it. This is a bug in the engine.`, platform, action };
    }

    const rt = this.runtime(accountId, platform, handle);
    const envBootstrap = platform === 'twitter' && !!(process.env.SOCIALCRABS_AUTH_TOKEN || process.env.AUTH_TOKEN);
    if (!vault.exists(accountId) && !envBootstrap) {
      return {
        success: false, code: 'no_session', platform, action,
        error: 'No session is stored for this account yet. Provision one with socialcrabs-service/scripts/connect-session.js, then verify it in the dashboard.',
      };
    }

    try {
      await this.pace(rt, action);
      const client = await this.ensureClient(rt);
      const handler = client[platform];
      if (!handler) throw Object.assign(new Error(`No ${platform} handler in the runtime.`), { code: 'unsupported_platform' });

      const target = payload.url || payload.username || payload.profileUrl || payload.query || null;
      const raw = await dispatch(handler, payload);
      rt.lastUsedAt = Date.now();

      const result = this.normalizeResult(platform, action, target, raw, started);

      // Any successful interaction may have refreshed cookies — persist them so
      // the stored session stays alive across redeploys.
      if (result.success) {
        const synced = await this.syncSessionBack(rt);
        if (!synced.ok) this.log('warn', `session not refreshed for ${accountId}: ${synced.error}`);
      } else {
        rt.lastError = result.error || 'The platform rejected the action.';
      }
      return result;
    } catch (e) {
      rt.lastError = e.message;
      return {
        success: false,
        code: e.code || 'engine_error',
        error: oneLine(e),
        platform,
        action,
        duration: Date.now() - started,
      };
    }
  }

  // ── LIFECYCLE ─────────────────────────────────────────────────────────────

  startIdleSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => { this.sweepIdle().catch(() => {}); }, 60 * 1000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  async sweepIdle() {
    const now = Date.now();
    for (const rt of [...this.runtimes.values()]) {
      if (!rt.clientReady) continue;
      if (now - rt.lastUsedAt < this.idleMs) continue;
      this.log('info', `closing idle browser for ${rt.accountId} (idle ${Math.round((now - rt.lastUsedAt) / 60000)} min)`);
      await this.closeRuntime(rt);
    }
  }

  async shutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const rt of [...this.runtimes.values()]) {
      await this.closeRuntime(rt);
    }
  }

  status() {
    return {
      provider: 'socialcrabs',
      provider_version: caps.manifest().provider_version_verified,
      started_at: new Date(this.startedAt).toISOString(),
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      accounts: this.listSessions().length,
      browsers_open: this.openBrowsers(),
      open_accounts: [...this.runtimes.values()].filter((rt) => rt.clientReady).map((rt) => rt.accountId),
      max_browsers: this.maxBrowsers,
      action_gap_ms: this.actionGapMs,
      idle_shutdown_minutes: Math.round(this.idleMs / 60000),
      encryption: !!vault.key(),
      session_dir: vault.SESSION_DIR,
      scratch_dir: vault.SCRATCH_ROOT,
    };
  }
}

// Every action the manifest calls supported must have a dispatch entry — caught
// at boot rather than when the creator presses a button.
function dispatchCoverage() {
  const missing = [];
  for (const platform of caps.platformIds()) {
    for (const [action, entry] of Object.entries(caps.platformInfo(platform).actions)) {
      if (!entry.supported) continue;
      if (typeof (DISPATCH[platform] || {})[action] !== 'function') missing.push(`${platform}/${action}`);
    }
  }
  return missing;
}

module.exports = { SocialEngine, DISPATCH, READ_ACTIONS, dispatchCoverage, defaultRuntimeFactory, oneLine };
