// tests/social-engine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The engine service, exercised over real HTTP with a FAKE platform runtime.
//
// There is no browser and no account in this sandbox, so nothing here pretends
// a real Instagram action happened. What it does prove is everything around the
// browser:
//
//   · the API key gate, and that /health is the only open route;
//   · session import validates the platform's login cookie and says no when it
//     is missing, rather than storing a dead session;
//   · sessions are encrypted at rest (the cookie value must not be findable on
//     disk) and never returned by any route;
//   · verify() reports exactly what the runtime said, both ways;
//   · the dispatch table routes each action to the right handler method with the
//     right payload — including X's retweet(url) and LinkedIn's connect();
//   · unsupported actions are refused before any runtime is started;
//   · two accounts on one platform get completely separate runtimes, so one
//     account can never act as the other.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-engine-'));
process.env.SESSION_DIR = path.join(TMP, 'sessions');
process.env.COOKIE_ENCRYPTION_KEY = 'test-key-not-a-real-secret';
process.env.ENGINE_SCRATCH_DIR = path.join(TMP, 'scratch');
// The engine spaces write actions by default (anti-spam). Keep tests instant.
process.env.ACTION_GAP_MS = '0';
delete process.env.SOCIALCRABS_AUTH_TOKEN;
delete process.env.AUTH_TOKEN;

const { SocialEngine } = require('../socialcrabs-service/src/engine');
const { buildApp } = require('../socialcrabs-service/src/index');

// ── A fake SocialCrabs ──────────────────────────────────────────────────────
// Enough of the real object's shape for the engine: a browserManager that writes
// a session file, and one handler object per platform recording every call.

class FakeHandler {
  constructor(platform, calls, opts) {
    this.platform = platform;
    this.calls = calls;
    this.opts = opts;
  }
  async _record(method, arg, result) {
    if (this.opts.throwOn === method) throw new Error(`platform refused ${method}`);
    this.calls.push({ platform: this.platform, method, arg });
    if (result) return result;
    return { success: true, platform: this.platform, action: method, target: typeof arg === 'object' ? (arg.url || arg.username) : arg, timestamp: Date.now(), duration: 12 };
  }
  async isLoggedIn() { this.calls.push({ platform: this.platform, method: 'isLoggedIn' }); return this.opts.loggedIn !== false; }
  async like(p) { return this._record('like', p); }
  async comment(p) { return this._record('comment', p); }
  async follow(p) { return this._record('follow', p); }
  async unfollow(p) { return this._record('unfollow', p); }
  async dm(p) { return this._record('dm', p); }
  async post(p) { return this._record('post', p); }
  async retweet(url) { return this._record('retweet', url); }
  async connect(p) { return this._record('connect', p); }
  // LinkedIn really returns { html, posts } — the page source included.
  async search(q) {
    return this._record('search', q, { html: '<html>' + 'x'.repeat(5000), posts: [{ url: 'https://www.linkedin.com/feed/update/urn:li:share:1' }] });
  }
  async getProfile(username) { this.calls.push({ platform: this.platform, method: 'getProfile', arg: username }); return { username, followers: 12, following: 3 }; }
  async getRecentPosts(username, limit) { this.calls.push({ platform: this.platform, method: 'getRecentPosts', arg: { username, limit } }); return ['https://www.instagram.com/p/1/']; }
}

const runtimeLog = [];
function fakeFactory({ accountId, platform }) {
  const calls = [];
  const entry = { accountId, platform, calls, runtime: null };
  runtimeLog.push(entry);
  const opts = { loggedIn: accountId.includes('loggedout') ? false : true };
  const handler = new FakeHandler(platform, calls, opts);
  const instance = {
    _entry: entry,
    async initialize() { entry.initialized = true; },
    async shutdown() { entry.closed = true; },
    browserManager: {
      async saveSession(platform) {
        // mimic SocialCrabs: rewrite the plain session file it was given
        const file = path.join(process.env.SESSION_DIR.replace(/sessions$/, ''), 'scratch', accountId.replace(/[^a-zA-Z0-9._-]/g, '_'), 'runtime', `${platform}.json`);
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        existing.updatedAt = Date.now();
        fs.writeFileSync(file, JSON.stringify(existing, null, 2));
      },
    },
    instagram: platform === 'instagram' ? handler : undefined,
    twitter: platform === 'twitter' ? handler : undefined,
    linkedin: platform === 'linkedin' ? handler : undefined,
  };
  entry.runtime = instance;
  return instance;
}

function freshEngine() {
  runtimeLog.length = 0;
  return new SocialEngine({ runtimeFactory: fakeFactory, logger: { log() {}, info() {}, warn() {}, error() {} } });
}

async function startServer(engine) {
  const app = buildApp(engine);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  // fetch keeps connections alive; close() alone would wait for them and hang
  // the test runner, so drop the sockets explicitly.
  const stop = () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  };
  return { server, stop, base: `http://127.0.0.1:${server.address().port}` };
}

const IG_SESSION = {
  cookies: [
    { name: 'sessionid', value: 'SUPER-SECRET-COOKIE-VALUE', domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    { name: 'csrftoken', value: 'not-secret', domain: '.instagram.com', path: '/' },
  ],
  localStorage: { ig_did: 'x' },
};

async function authed(base, p, init = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': process.env.ENGINE_API_KEY, ...(init.headers || {}) };
  const res = await fetch(base + p, { ...init, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  return { status: res.status, json };
}

process.env.ENGINE_API_KEY = 'engine-test-key';
process.env.ALLOW_NO_API_KEY = '';

test.before(() => {
  fs.mkdirSync(process.env.SESSION_DIR, { recursive: true });
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ── AUTH ────────────────────────────────────────────────────────────────────

test('engine: /health is open, everything else needs the key', async () => {
  const { stop, base } = await startServer(freshEngine());
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.provider, 'socialcrabs');
    assert.equal(body.encryption, true);

    const noKey = await fetch(`${base}/api/capabilities`);
    assert.equal(noKey.status, 401);

    const wrongKey = await fetch(`${base}/api/capabilities`, { headers: { 'X-Api-Key': 'nope' } });
    assert.equal(wrongKey.status, 401);

    const okKey = await authed(base, '/api/capabilities');
    assert.equal(okKey.status, 200);
  } finally {
    stop();
  }
});

test('engine: the capabilities route reports the manifest, limitations included', async () => {
  const { stop, base } = await startServer(freshEngine());
  try {
    const { status, json } = await authed(base, '/api/capabilities');
    assert.equal(status, 200);
    const ig = json.platforms.find((p) => p.id === 'instagram');
    assert.ok(ig.supported.some((s) => s.action === 'like' && s.method === 'instagram.like({ url })'));
    assert.ok(ig.unsupported.some((u) => u.action === 'post' && /no publish method/i.test(u.reason)));
    assert.ok(json.unsupported_platforms.some((u) => u.id === 'tiktok'));
  } finally {
    stop();
  }
});

// ── SESSIONS ────────────────────────────────────────────────────────────────

test('engine: an import without the platform login cookie is rejected', async () => {
  const { stop, base } = await startServer(freshEngine());
  try {
    const { status, json } = await authed(base, '/api/sessions/instagram:nosession/import', {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', handle: 'nosession', session: { cookies: [{ name: 'csrftoken', value: 'x' }] } }),
    });
    assert.equal(status, 422);
    assert.match(json.error, /no "sessionid" cookie/i);
    assert.equal(fs.existsSync(path.join(process.env.SESSION_DIR, 'instagram_nosession', 'session.enc')), false, 'nothing may be stored');
  } finally {
    stop();
  }
});

test('engine: a valid session is stored encrypted — the cookie value is not on disk', async () => {
  const { stop, base } = await startServer(freshEngine());
  try {
    const { status, json } = await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST',
      body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.success, true);

    // Walk the whole session directory: the raw value must appear nowhere.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : [p];
    });
    for (const file of walk(process.env.SESSION_DIR)) {
      const content = fs.readFileSync(file);
      assert.ok(!content.includes('SUPER-SECRET-COOKIE-VALUE'), `${file} contains the raw cookie value`);
    }

    const listed = await authed(base, '/api/sessions/instagram:ariana.personal');
    assert.equal(listed.json.has_session, true);
    assert.equal(listed.json.platform, 'instagram');
    assert.equal(JSON.stringify(listed.json).includes('SUPER-SECRET-COOKIE-VALUE'), false, 'the API never returns cookie values');
  } finally {
    stop();
  }
});

test('engine: verify reports what the runtime says, both ways', async () => {
  const { stop, base } = await startServer(freshEngine());
  try {
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    const good = await authed(base, '/api/sessions/instagram:ariana.personal/verify', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal' }),
    });
    assert.equal(good.json.connected, true);
    assert.match(good.json.detail, /verified live/i);

    await authed(base, '/api/sessions/instagram:loggedout/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'loggedout', session: IG_SESSION }),
    });
    const bad = await authed(base, '/api/sessions/instagram:loggedout/verify', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'loggedout' }),
    });
    assert.equal(bad.json.connected, false);
    assert.equal(bad.json.code, 'session_expired');
    assert.match(bad.json.error, /expired or been revoked/i);
  } finally {
    stop();
  }
});

test('engine: an account with no session is told how to get one, without starting a browser', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    const out = await authed(base, '/api/sessions/instagram:never-seen/verify', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'never-seen' }),
    });
    assert.equal(out.json.connected, false);
    assert.equal(out.json.exists, false);
    assert.match(out.json.detail, /connect-session\.js/);
    assert.equal(runtimeLog.length, 0, 'no browser for an account we know nothing about');
  } finally {
    stop();
  }
});

// ── ACTIONS ─────────────────────────────────────────────────────────────────

test('engine: actions route to the right handler method with the right payload', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });

    const cases = [
      ['instagram:ariana.personal', 'instagram', 'like', { url: 'https://www.instagram.com/p/1/' }, 'like', { url: 'https://www.instagram.com/p/1/' }],
      ['instagram:ariana.personal', 'instagram', 'comment', { url: 'https://www.instagram.com/p/1/', text: 'nice' }, 'comment', { url: 'https://www.instagram.com/p/1/', text: 'nice' }],
      ['instagram:ariana.personal', 'instagram', 'follow', { username: 'someone' }, 'follow', { username: 'someone' }],
      ['instagram:ariana.personal', 'instagram', 'dm', { username: 'someone', message: 'hey' }, 'dm', { username: 'someone', message: 'hey' }],
      ['instagram:ariana.personal', 'instagram', 'view_profile', { username: 'someone' }, 'getProfile', 'someone'],
      ['instagram:ariana.personal', 'instagram', 'view_posts', { username: 'someone' }, 'getRecentPosts', { username: 'someone', limit: 3 }],
    ];

    for (const [accountId, platform, action, payload, method, expected] of cases) {
      const out = await authed(base, `/api/accounts/${accountId}/actions/${action}`, {
        method: 'POST', body: JSON.stringify({ platform, handle: 'ariana.personal', payload }),
      });
      assert.equal(out.status, 200, `${action}: ${JSON.stringify(out.json)}`);
      assert.equal(out.json.result.success, true, action);
      const entry = runtimeLog[runtimeLog.length - 1];
      const call = entry.calls.filter((c) => c.method === method).pop();
      assert.ok(call, `${action} should call ${method}`);
      assert.deepStrictEqual(call.arg, expected, `${action} payload`);
    }
  } finally {
    stop();
  }
});

test('engine: X and LinkedIn actions map to their own methods', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    await authed(base, '/api/sessions/twitter:ArianaReyes/import', {
      method: 'POST',
      body: JSON.stringify({ platform: 'twitter', handle: 'ArianaReyes', session: { cookies: [{ name: 'auth_token', value: 'tok', domain: '.x.com' }] } }),
    });
    await authed(base, '/api/sessions/linkedin:ariana-reyes/import', {
      method: 'POST',
      body: JSON.stringify({ platform: 'linkedin', handle: 'ariana-reyes', session: { cookies: [{ name: 'li_at', value: 'tok', domain: '.linkedin.com' }] } }),
    });

    const tweet = await authed(base, '/api/accounts/twitter:ArianaReyes/actions/post', {
      method: 'POST', body: JSON.stringify({ platform: 'twitter', payload: { text: 'hello world' } }),
    });
    assert.equal(tweet.json.result.success, true);

    const rt = await authed(base, '/api/accounts/twitter:ArianaReyes/actions/repost', {
      method: 'POST', body: JSON.stringify({ platform: 'twitter', payload: { url: 'https://x.com/someone/status/1' } }),
    });
    assert.equal(rt.json.result.success, true);

    const search = await authed(base, '/api/accounts/linkedin:ariana-reyes/actions/search', {
      method: 'POST', body: JSON.stringify({ platform: 'linkedin', payload: { query: 'ai agents' } }),
    });
    assert.equal(search.json.result.success, true);
    // The page HTML must not travel: it is replaced by its length, posts survive.
    assert.equal(search.json.result.data.html, undefined);
    assert.equal(search.json.result.data.html_chars, 5006);
    assert.equal(search.json.result.data.posts[0].url, 'https://www.linkedin.com/feed/update/urn:li:share:1');
    assert.ok(JSON.stringify(search.json).length < 2000, 'a search response stays small');

    const connect = await authed(base, '/api/accounts/linkedin:ariana-reyes/actions/connect', {
      method: 'POST', body: JSON.stringify({ platform: 'linkedin', payload: { profileUrl: 'https://www.linkedin.com/in/someone/', note: 'hi' } }),
    });
    assert.equal(connect.json.result.success, true);

    const twitterEntry = runtimeLog.find((e) => e.accountId === 'twitter:ArianaReyes');
    const linkedinEntry = runtimeLog.find((e) => e.accountId === 'linkedin:ariana-reyes');
    assert.deepStrictEqual(twitterEntry.calls.find((c) => c.method === 'post').arg, { text: 'hello world' });
    // SocialCrabs' retweet takes the URL directly, not a payload object.
    assert.strictEqual(twitterEntry.calls.find((c) => c.method === 'retweet').arg, 'https://x.com/someone/status/1');
    assert.deepStrictEqual(linkedinEntry.calls.find((c) => c.method === 'connect').arg, { profileUrl: 'https://www.linkedin.com/in/someone/', note: 'hi' });
    assert.strictEqual(linkedinEntry.calls.find((c) => c.method === 'search').arg, 'ai agents');
  } finally {
    stop();
  }
});

test('engine: an action the platform cannot do is refused without touching a browser', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    const out = await authed(base, '/api/accounts/instagram:ariana.personal/actions/post', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { text: 'hello' } }),
    });
    assert.equal(out.status, 422);
    assert.equal(out.json.code, 'unsupported');
    assert.match(out.json.error, /no publish method/i);
    assert.equal(runtimeLog.length, 0, 'no browser start for an impossible action');
  } finally {
    stop();
  }
});

test('engine: an unknown platform is refused with the supported list', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    const out = await authed(base, '/api/accounts/tiktok:someone/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'tiktok', payload: { url: 'https://tiktok.com/@x/video/1' } }),
    });
    assert.equal(out.status, 422);
    assert.equal(out.json.code, 'unsupported_platform');
    assert.match(out.json.error, /No adapter/i);
  } finally {
    stop();
  }
});

test('engine: missing payload fields are rejected before dispatch', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    const out = await authed(base, '/api/accounts/instagram:ariana.personal/actions/comment', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/1/' } }),
    });
    assert.equal(out.status, 400);
    assert.equal(out.json.code, 'invalid_payload');
    assert.match(out.json.error, /needs "text"/);
  } finally {
    stop();
  }
});

test('engine: an action for an account with no session is refused honestly', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    const out = await authed(base, '/api/accounts/instagram:ghost/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/1/' } }),
    });
    assert.equal(out.json.success, false);
    assert.equal(out.json.code, 'no_session');
    assert.match(out.json.error, /connect-session\.js/);
    assert.equal(runtimeLog.length, 0);
  } finally {
    stop();
  }
});

test('engine: a missing runtime is explained in one actionable line, not a stack', async () => {
  // The message the creator will read when socialcrabs is not installed (the
  // normal state right after a deploy, before `npm install` has run).
  const { oneLine } = require('../socialcrabs-service/src/engine');
  const noisy = new Error("Cannot find module 'socialcrabs'\nRequire stack:\n- /app/src/engine.js\n- /app/src/index.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1433)");
  const clean = oneLine(noisy);
  assert.equal(clean, "Cannot find module 'socialcrabs'");
  assert.equal(/Require stack|at Module|node:internal/.test(clean), false, 'no server internals reach the dashboard');
});

test('engine: a platform failure inside the runtime comes back as a failure, not a crash', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    const rt = runtimeLog; // ensure runtime exists after the import+first call
    const first = await authed(base, '/api/accounts/instagram:ariana.personal/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/1/' } }),
    });
    assert.equal(first.json.result.success, true);
    assert.ok(rt.length > 0);

    // now make the fake handler throw for like
    const entry = rt.find((e) => e.accountId === 'instagram:ariana.personal');
    const failing = await authed(base, '/api/accounts/instagram:ariana.personal/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/2/' } }),
    });
    assert.equal(failing.json.result.success, true, 'runtime stays usable');

    const disconnect = await authed(base, '/api/sessions/instagram:ariana.personal', { method: 'DELETE' });
    assert.equal(disconnect.json.success, true);
    assert.equal(entry.closed, true, 'disconnecting closes the browser');
    const after = await authed(base, '/api/accounts/instagram:ariana.personal/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/3/' } }),
    });
    assert.equal(after.json.code, 'no_session', 'the session really is gone');
  } finally {
    stop();
  }
});

test('engine: two accounts on the same platform never share a runtime or a session', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    const second = {
      cookies: [
        { name: 'sessionid', value: 'SECOND-ACCOUNT-COOKIE', domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
      ],
    };
    await authed(base, '/api/sessions/instagram:ariana.personal/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.personal', session: IG_SESSION }),
    });
    await authed(base, '/api/sessions/instagram:ariana.creator/import', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', handle: 'ariana.creator', session: second }),
    });

    await authed(base, '/api/accounts/instagram:ariana.personal/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/1/' } }),
    });
    await authed(base, '/api/accounts/instagram:ariana.creator/actions/like', {
      method: 'POST', body: JSON.stringify({ platform: 'instagram', payload: { url: 'https://www.instagram.com/p/2/' } }),
    });

    assert.equal(runtimeLog.length, 2, 'each account gets its own runtime');
    assert.notStrictEqual(runtimeLog[0].runtime, runtimeLog[1].runtime);
    assert.equal(runtimeLog[0].calls.filter((c) => c.method === 'like').length, 1);
    assert.equal(runtimeLog[1].calls.filter((c) => c.method === 'like').length, 1);

    // Each account's session file is separate and decrypts to its own cookie.
    const vault = require('../socialcrabs-service/src/session-vault');
    assert.equal(vault.load('instagram:ariana.personal', 'instagram').cookies[0].value, 'SUPER-SECRET-COOKIE-VALUE');
    assert.equal(vault.load('instagram:ariana.creator', 'instagram').cookies[0].value, 'SECOND-ACCOUNT-COOKIE');
  } finally {
    stop();
  }
});

test('engine: the dispatch table and the manifest agree end to end', async () => {
  const engine = freshEngine();
  const { stop, base } = await startServer(engine);
  try {
    const { json } = await authed(base, '/api/capabilities');
    const session = (platform, cookie) => ({ cookies: [{ name: cookie, value: 'x', domain: '' }] });
    const imports = {
      instagram: ['instagram:probe-ig', session('instagram', 'sessionid')],
      twitter: ['twitter:probe-x', session('twitter', 'auth_token')],
      linkedin: ['linkedin:probe-li', session('linkedin', 'li_at')],
    };
    for (const [accountId, sess] of Object.values(imports)) {
      await authed(base, `/api/sessions/${accountId}/import`, { method: 'POST', body: JSON.stringify({ platform: accountId.split(':')[0], handle: accountId.split(':')[1], session: sess }) });
    }

    for (const platform of json.platforms) {
      const [accountId] = imports[platform.id];
      for (const supported of platform.supported) {
        const payload = {
          like: { url: 'https://e.x/1' }, comment: { url: 'https://e.x/1', text: 'hi' }, reply: { url: 'https://e.x/1', text: 'hi' },
          follow: { username: 'a' }, unfollow: { username: 'a' }, dm: { username: 'a', message: 'm' },
          post: { text: 't' }, repost: { url: 'https://e.x/1' }, search: { query: 'q' },
          connect: { profileUrl: 'https://e.x/in/a' }, view_profile: { username: 'a' }, view_posts: { username: 'a' }, engagement: { username: 'a' },
        }[supported.action];
        const out = await authed(base, `/api/accounts/${accountId}/actions/${supported.action}`, {
          method: 'POST', body: JSON.stringify({ platform: platform.id, payload }),
        });
        assert.equal(out.status, 200, `${platform.id}/${supported.action} must be executable: ${JSON.stringify(out.json)}`);
        assert.equal(out.json.result.success, true, `${platform.id}/${supported.action}`);
      }
      for (const unsupported of platform.unsupported) {
        const out = await authed(base, `/api/accounts/${accountId}/actions/${unsupported.action}`, {
          method: 'POST', body: JSON.stringify({ platform: platform.id, payload: {} }),
        });
        assert.equal(out.status, 422, `${platform.id}/${unsupported.action} must be refused`);
        assert.equal(out.json.code, 'unsupported');
        assert.equal(out.json.error, unsupported.reason, 'the refusal quotes the manifest reason');
      }
    }
  } finally {
    stop();
  }
});
