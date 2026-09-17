// tests/social-tools.test.js
// ─────────────────────────────────────────────────────────────────────────────
// What Ariana is offered, and what happens when she uses it.
//
// The important assertions in here are about honesty:
//   · the tool list contains exactly what the enabled accounts can really do —
//     no social_post when only Instagram is connected, no social_search at all
//     until LinkedIn is;
//   · nothing is sent to the engine when the platform cannot do it, when the
//     creator switched actions off, or when the call is a dry run;
//   · the activity log and the text handed back to the model both describe what
//     actually happened, failures included.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-tools-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.SOCIAL_DRY_RUN;

const accounts = require('../social/accounts');
const tools = require('../social/tools');
const activity = require('../social/activity');
const guards = require('../social/guards');

const realFetch = global.fetch;
let fetchCalls = [];

function fakeEngine(handler) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    fetchCalls.push({ url: String(url), body });
    const out = handler ? handler({ url: String(url), body }) : { status: 200, json: { result: { success: true, platform: 'instagram', action: 'like' } } };
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      text: async () => JSON.stringify(out.json),
    };
  };
}

function resetStore() {
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) {
    try { fs.rmSync(path.join(TMP, f)); } catch (_) {}
  }
  accounts.invalidate();
  delete process.env.SOCIAL_ENGINE_URL;
  delete process.env.SOCIAL_DRY_RUN;
  global.fetch = realFetch;
}

async function enable(platform, handle) {
  const out = await accounts.add({ platform, handle });
  assert.equal(out.ok, true, out.error);
  await accounts.setActionsEnabled(out.account.account_id, true);
  return out.account.account_id;
}

test.after(() => {
  global.fetch = realFetch;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ── WHAT SHE IS OFFERED ─────────────────────────────────────────────────────

test('tools: with no enabled account she is offered nothing at all', async () => {
  resetStore();
  await accounts.add({ platform: 'instagram', handle: 'disabled_one' }); // actions off
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  assert.deepStrictEqual(await tools.buildToolSchemas(), []);
});

test('tools: Instagram only — no posting tool, no search tool, no repost tool', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  await enable('instagram', 'ariana.personal');

  const names = (await tools.buildToolSchemas()).map((t) => t.function.name);
  for (const expected of ['social_like', 'social_comment', 'social_follow', 'social_unfollow', 'social_dm', 'social_view_profile', 'social_view_posts', 'social_engagement', 'social_accounts']) {
    assert.ok(names.includes(expected), `${expected} should be offered for Instagram`);
  }
  for (const forbidden of ['social_post', 'social_repost', 'social_reply', 'social_search', 'social_connect']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered when it cannot work`);
  }
});

test('tools: connecting X adds publishing and reposting, and nothing more', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  await enable('instagram', 'ariana.personal');
  await enable('twitter', 'ArianaReyes');

  const schemas = await tools.buildToolSchemas();
  const names = schemas.map((t) => t.function.name);
  assert.ok(names.includes('social_post'), 'X can publish, so the tool exists now');
  assert.ok(names.includes('social_repost'));
  assert.ok(names.includes('social_reply'));

  // LinkedIn-only abilities stay out
  assert.ok(!names.includes('social_search'));
  assert.ok(!names.includes('social_connect'));

  // the description tells her where it works
  const post = schemas.find((t) => t.function.name === 'social_post');
  assert.match(post.function.description, /Works on: X/);
  assert.match(post.function.description, /not to farm engagement/);
});

test('tools: LinkedIn-only setup gets search and connection requests, not posting', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  await enable('linkedin', 'ariana-reyes');

  const names = (await tools.buildToolSchemas()).map((t) => t.function.name);
  assert.ok(names.includes('social_search'));
  assert.ok(names.includes('social_connect'));
  assert.ok(!names.includes('social_post'));
  assert.ok(!names.includes('social_repost'));
  assert.ok(!names.includes('social_view_posts'), 'LinkedIn cannot list posts');
});

// ── WHAT ACTUALLY LEAVES THE BUILDING ───────────────────────────────────────

test('execute: with no engine configured nothing is sent and the log says so', async () => {
  resetStore();
  fakeEngine();
  const id = await enable('instagram', 'ariana.personal');

  const result = await tools.executeTool('social_like', { url: 'https://www.instagram.com/p/AAA/', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_configured');
  assert.equal(fetchCalls.length, 0, 'no engine, no request');
  assert.match(result.error, /SOCIAL_ENGINE_URL/);

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.status_label, 'Failed');
  assert.match(entry.summary, /Could not like/i);
  assert.match(entry.error, /engine not connected/i);
  assert.match(tools.toolResultForModel(result), /no backend connected/i);
});

test('execute: a platform that cannot do it is refused locally, with the reason', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  fakeEngine();
  const id = await enable('instagram', 'ariana.personal');

  // social_post is not even in her tool list here; calling it directly must not
  // reach the network either.
  const result = await tools.executeTool('social_post', { text: 'hello world', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported');
  assert.match(result.error, /no publish method/i);
  assert.equal(fetchCalls.length, 0, 'the engine is never troubled with an impossible action');

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'unsupported');
  assert.equal(entry.status_label, 'Not supported');
  assert.match(tools.toolResultForModel(result), /impossible on this platform/i);
});

test('execute: an action on a switched-off account is blocked before the network', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  fakeEngine();
  const out = await accounts.add({ platform: 'instagram', handle: 'off_account' });

  const result = await tools.executeTool('social_like', { url: 'https://www.instagram.com/p/BBB/', account: out.account.account_id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'actions_disabled');
  assert.equal(fetchCalls.length, 0);
  const [entry] = await activity.recent(1, out.account.account_id);
  assert.equal(entry.status, 'blocked', 'the creator sees a permission stop, not a platform error');
});

test('execute: a dry run exercises everything but sends nothing', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  process.env.SOCIAL_DRY_RUN = '1';
  fakeEngine();
  const id = await enable('instagram', 'ariana.personal');

  const result = await tools.executeTool('social_comment', { url: 'https://www.instagram.com/p/CCC/', text: 'nice one', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dry_run');
  assert.equal(fetchCalls.length, 0);
  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'skipped');
  assert.equal(entry.detail.dry_run, true);
  assert.equal(entry.detail.would_send.text, 'nice one');
  process.env.SOCIAL_DRY_RUN = '';
});

test('execute: a real success is sent once, logged, and described as done', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  const id = await enable('instagram', 'ariana.personal');
  fakeEngine(({ url }) => ({
    status: 200,
    json: { result: { success: true, platform: 'instagram', action: 'like', target: 'https://www.instagram.com/p/DDD/', duration: 1234 } },
  }));

  const result = await tools.executeTool('social_like', { url: 'https://www.instagram.com/p/DDD/', account: id, username: 'someone' }, { source: 'chat' });
  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/accounts\/instagram%3Aariana\.personal\/actions\/like$/);
  assert.deepStrictEqual(fetchCalls[0].body.payload, { url: 'https://www.instagram.com/p/DDD/' });

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'completed');
  assert.equal(entry.action, 'like');
  assert.equal(entry.summary, "Liked @someone's post");
  assert.equal(entry.actor, 'ariana');
  assert.ok(entry.duration_ms >= 0);

  assert.match(tools.toolResultForModel(result), /\[social action completed\]/);
});

test('execute: when the engine refuses, the failure is surfaced — never smoothed over', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  const id = await enable('instagram', 'ariana.personal');
  fakeEngine(() => ({ status: 502, json: { success: false, code: 'session_expired', error: 'The session is no longer logged in.' } }));

  const result = await tools.executeTool('social_comment', { url: 'https://www.instagram.com/p/EEE/', text: 'hi', account: id }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session_expired');
  assert.match(result.error, /no longer logged in/);

  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'failed');
  assert.match(entry.summary, /Comment failed/i);
  assert.equal(entry.error, 'The session is no longer logged in.');
  assert.match(tools.toolResultForModel(result), /social action failed/);
});

test('execute: she must name the account when two could do the job', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  fakeEngine();
  await enable('instagram', 'ariana.personal');
  await enable('instagram', 'ariana.creator');

  const result = await tools.executeTool('social_like', { url: 'https://www.instagram.com/p/FFF/' }, { source: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'account_required');
  assert.equal(fetchCalls.length, 0, 'never guess between two accounts');
  assert.match(result.error, /instagram:ariana\.personal/);
  assert.match(result.error, /instagram:ariana\.creator/);
});

test('execute: a batch is spaced sequentially and reported as one event', async () => {
  resetStore();
  process.env.SOCIAL_ENGINE_URL = 'https://engine.example';
  const id = await enable('instagram', 'ariana.personal');
  fakeEngine(({ body }) => ({ status: 200, json: { result: { success: true, platform: 'instagram', action: 'like', target: body.payload.url } } }));

  const { token } = guards.createConfirmation({ accountId: id, action: 'like', maxTargets: 3 });
  const result = await tools.executeTool('social_like', {
    url: 'https://www.instagram.com/p/1/',
    targets: ['https://www.instagram.com/p/2/', 'https://www.instagram.com/p/3/'],
    account: id,
  }, { source: 'chat', confirmationToken: token });

  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 3, 'one request per target, none in parallel');
  assert.deepStrictEqual(fetchCalls.map((c) => c.body.payload.url), [
    'https://www.instagram.com/p/1/', 'https://www.instagram.com/p/2/', 'https://www.instagram.com/p/3/',
  ]);
  const [entry] = await activity.recent(1, id);
  assert.equal(entry.status, 'completed');
  assert.equal(entry.detail.batch, 3);
  assert.equal(entry.detail.succeeded, 3);
});

test('execute: social_accounts tells her what she has and what it can do', async () => {
  resetStore();
  await enable('instagram', 'ariana.personal');
  const result = await tools.executeTool('social_accounts', {}, { source: 'chat' });
  assert.equal(result.ok, true);
  const ig = result.data.platforms.find((p) => p.platform === 'instagram');
  assert.ok(ig.can.includes('like'));
  assert.ok(ig.cannot.some((c) => c.action === 'post' && /no publish method/i.test(c.reason)));
});

test('execute: the tool list never claims a capability the manifest does not have', async () => {
  resetStore();
  const names = (await tools.buildToolSchemas()).map((t) => t.function.name);
  assert.deepStrictEqual(names, []);
});
