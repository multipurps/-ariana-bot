// socialcrabs-service/src/index.js
// ─────────────────────────────────────────────────────────────────────────────
// The engine's HTTP surface. Ariana (or an operator's script) talks to it with
// a shared API key; everything except /health requires it.
//
//   GET    /health                                  liveness, no auth
//   GET    /api/capabilities                        what this engine can really do
//   GET    /api/sessions                            sessions this engine holds
//   GET    /api/sessions/:accountId                 one session's state
//   POST   /api/sessions/:accountId/verify          open the platform, check the login
//   POST   /api/sessions/:accountId/import          store a session (operator script only)
//   DELETE /api/sessions/:accountId                 forget a session
//   POST   /api/accounts/:accountId/actions/:action perform an action
//
// The import route exists for the connect-session helper that runs on the
// operator's own machine. It is never called from a browser page: Ariana's
// dashboard has no route that accepts credentials, and the engine's key never
// reaches the frontend.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const caps = require('./capabilities');
const { SocialEngine, dispatchCoverage } = require('./engine');

const PORT = parseInt(process.env.PORT, 10) || 3847;
const HOST = process.env.HOST || '0.0.0.0';

// Read at call time, not at import time: tests and the CLI set the key after
// loading this module, and a key rotated in the environment should take effect.
function apiKey() {
  return process.env.ENGINE_API_KEY || process.env.API_KEY || null;
}
function allowNoKey() {
  return process.env.ALLOW_NO_API_KEY === '1';
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function buildApp(engine) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // One line per request — enough to debug, no bodies, no cookies.
  app.use((req, _res, next) => {
    if (process.env.LOG_REQUESTS !== '0') {
      console.log(`[http] ${req.method} ${req.path}`);
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: 'socialcrabs',
      provider_version: caps.manifest().provider_version_verified,
      encryption: !!require('./session-vault').key(),
      browsers_open: engine.openBrowsers(),
      accounts: engine.listSessions().length,
      uptime: Math.round(process.uptime()),
    });
  });

  // Everything below needs the key.
  app.use('/api', (req, res, next) => {
    const key = apiKey();
    if (!key) return next(); // only possible when ALLOW_NO_API_KEY=1 (checked at boot)
    const provided = req.get('x-api-key') || req.query.api_key || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!provided || !timingSafeEqual(provided, key)) {
      return res.status(401).json({ error: 'Missing or invalid API key. Set X-Api-Key on every request.' });
    }
    next();
  });

  app.get('/api/capabilities', (_req, res) => res.json(caps.describe()));

  app.get('/api/sessions', (_req, res) => res.json({ sessions: engine.listSessions(), status: engine.status() }));

  app.get('/api/sessions/:accountId', (req, res) => {
    const platform = req.query.platform || null;
    res.json(engine.sessionStatus({ accountId: req.params.accountId, platform }));
  });

  app.post('/api/sessions/:accountId/verify', async (req, res) => {
    const { platform, handle } = req.body || {};
    if (!platform) return res.status(400).json({ error: 'platform is required.' });
    const out = await engine.verify({ accountId: req.params.accountId, platform, handle });
    if (out.code === 'unsupported_platform') return res.status(400).json(out);
    res.json(out);
  });

  app.post('/api/sessions/:accountId/import', (req, res) => {
    const { platform, handle, session } = req.body || {};
    if (!platform || !session) return res.status(400).json({ error: 'platform and session are required.' });
    const out = engine.importSession({ accountId: req.params.accountId, platform, handle, session });
    if (!out.success) return res.status(422).json(out);
    res.json(out);
  });

  app.delete('/api/sessions/:accountId', async (req, res) => {
    res.json(await engine.disconnect({ accountId: req.params.accountId }));
  });

  app.post('/api/accounts/:accountId/actions/:action', async (req, res) => {
    const { platform, handle, payload } = req.body || {};
    if (!platform) return res.status(400).json({ success: false, code: 'invalid_payload', error: 'platform is required.' });
    const out = await engine.act({
      accountId: req.params.accountId,
      platform,
      handle,
      action: String(req.params.action || '').toLowerCase(),
      payload: payload || {},
    });
    if (!out.success) {
      const status = out.code === 'unsupported' || out.code === 'unsupported_platform' ? 422
        : out.code === 'invalid_payload' ? 400
        : out.code === 'browser_limit' ? 429
        : 502;
      return res.status(status).json(out);
    }
    res.json({ result: out });
  });

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}.` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[http] unhandled error:', err.message);
    res.status(500).json({ error: 'The engine hit an unexpected error.', detail: err.message });
  });

  return app;
}

function main() {
  if (!apiKey() && !allowNoKey()) {
    console.error('Refusing to start: ENGINE_API_KEY is not set. Generate one (openssl rand -hex 24), set it here and as SOCIAL_ENGINE_API_KEY on Ariana. For a throwaway local test only, set ALLOW_NO_API_KEY=1.');
    process.exit(1);
  }
  if (!apiKey() && allowNoKey()) {
    console.warn('WARNING: starting with no API key (ALLOW_NO_API_KEY=1). Never expose this to the internet.');
  }
  if (!require('./session-vault').key() && process.env.ALLOW_INSECURE_SESSION_STORAGE !== '1') {
    console.error('Refusing to start: COOKIE_ENCRYPTION_KEY is not set, so stored sessions could not be encrypted. Set it (openssl rand -hex 32), or set ALLOW_INSECURE_SESSION_STORAGE=1 to accept plaintext on a throwaway dev box.');
    process.exit(1);
  }

  const missing = dispatchCoverage();
  if (missing.length) {
    console.error(`Refusing to start: the capability manifest advertises actions with no handler: ${missing.join(', ')}. Fix the dispatch table in src/engine.js or correct src/capabilities.json.`);
    process.exit(1);
  }

  const vault = require('./session-vault');
  console.log(`[boot] provider ${caps.manifest().provider} ${caps.manifest().provider_version_verified}`);
  console.log(`[boot] sessions: ${vault.SESSION_DIR} (${vault.key() ? 'encrypted' : 'PLAINTEXT — insecure'})`);
  console.log(`[boot] scratch: ${vault.SCRATCH_ROOT}`);
  console.log(`[boot] capabilities: ${caps.platformIds().map((p) => `${p}(${Object.values(caps.platformInfo(p).actions).filter((a) => a.supported).length})`).join(' ')}`);

  const engine = new SocialEngine();
  engine.startIdleSweeper();
  const app = buildApp(engine);

  const server = app.listen(PORT, HOST, () => {
    console.log(`[boot] listening on http://${HOST}:${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`[boot] ${signal} — saving sessions and closing browsers`);
    try { await engine.shutdown(); } catch (e) { console.error('[boot] shutdown error:', e.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { buildApp };
