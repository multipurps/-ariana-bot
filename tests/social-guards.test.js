// tests/social-guards.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The safety layer, tested against the things it exists to stop:
//
//   · an action the platform cannot do          → refused with the reason
//   · an account the creator switched off       → refused, and it says so
//   · a batch bigger than the ceiling           → refused outright
//   · hitting the daily limit                   → refused, and only that action
//   · unfollow / publishing / batches           → need a human confirmation
//   · a reused, expired or wrong-scope token    → refused
//
// Limits and confirmations are the feature. If these tests ever get relaxed to
// make something pass, the feature is gone.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

// Isolate state before requiring anything that reads SOCIAL_DATA_DIR.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ariana-social-guards-'));
process.env.SOCIAL_DATA_DIR = TMP;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SOCIAL_ENGINE_URL;
delete process.env.SOCIAL_DRY_RUN;

const caps = require('../social/capabilities');
const accounts = require('../social/accounts');
const guards = require('../social/guards');
const activity = require('../social/activity');

function resetStore() {
  for (const f of ['accounts.json', 'activity.jsonl', 'config.json']) {
    try { fs.rmSync(path.join(TMP, f)); } catch (_) {}
  }
  accounts.invalidate();
}

async function seededAccount(platform, handle, { enabled = true } = {}) {
  const out = await accounts.add({ platform, handle });
  assert.equal(out.ok, true, out.error);
  if (enabled) await accounts.setActionsEnabled(out.account.account_id, true);
  return accounts.get(out.account.account_id);
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('guard: an unsupported action is refused with the platform\'s own reason', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'ariana.personal');
  const res = await guards.check({ account, action: 'post', count: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unsupported');
  assert.equal(res.status, 'unsupported');
  assert.match(res.error, /no publish method/i);
});

test('guard: an account with actions switched off is refused, and the refusal says why', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'switched_off', { enabled: false });
  const res = await guards.check({ account, action: 'like', count: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'actions_disabled');
  assert.equal(res.status, 'blocked');
  assert.match(res.error, /disabled for switched_off/);
  assert.match(res.error, /dashboard/);
});

test('guard: a batch over the ceiling is refused outright, not truncated', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'batcher');
  const res = await guards.check({ account, action: 'like', count: guards.BATCH_MAX + 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'batch_too_large');
  assert.match(res.error, new RegExp(`${guards.BATCH_MAX}-action ceiling`));
  assert.match(res.error, /Mass actions are not something Ariana does/);
});

test('guard: an action that cannot be batched is not silently expanded', async () => {
  resetStore();
  const account = await seededAccount('linkedin', 'ariana-reyes');
  const res = await guards.check({ account, action: 'search', count: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_batchable');
});

test('guard: the daily ceiling counts what actually ran, per account and action', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'limited');
  const limit = guards.defaultLimits().like;

  for (let i = 0; i < limit; i++) {
    await activity.record({ account, action: 'like', status: 'completed', created_at: new Date().toISOString() });
  }
  const res = await guards.check({ account, action: 'like', count: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'daily_limit');
  assert.match(res.error, new RegExp(`${limit}/${limit}`));
  assert.match(res.error, /SOCIAL_MAX_LIKE/, 'the refusal tells the creator how to raise it');

  // A different action on the same account is unaffected…
  assert.equal((await guards.check({ account, action: 'comment', count: 1 })).ok, true);
  // …and so is a different account.
  const other = await seededAccount('instagram', 'not_limited');
  assert.equal((await guards.check({ account: other, action: 'like', count: 1 })).ok, true);
});

test('guard: things that were blocked or skipped do not consume the daily budget', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'blocked_only');
  for (let i = 0; i < 20; i++) {
    await activity.record({ account, action: 'dm', status: 'blocked', error: 'nope' });
    await activity.record({ account, action: 'dm', status: 'skipped' });
    await activity.record({ account, action: 'dm', status: 'needs_confirmation' });
  }
  const res = await guards.check({ account, action: 'dm', count: 1 });
  assert.equal(res.ok, true, 'nothing actually left the building, so nothing was spent');
});

test('guard: unfollowing always needs a human yes — and the token is single-use', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'careful');

  const first = await guards.check({ account, action: 'unfollow', count: 1 });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'needs_confirmation');
  assert.equal(first.status, 'needs_confirmation');
  assert.match(first.error, /always needs a human yes/);

  const { token } = guards.createConfirmation({ accountId: account.account_id, action: 'unfollow', maxTargets: 1 });
  assert.equal((await guards.check({ account, action: 'unfollow', count: 1, confirmationToken: token })).ok, true);

  const replay = await guards.check({ account, action: 'unfollow', count: 1, confirmationToken: token });
  assert.equal(replay.ok, false, 'a confirmation must not be reusable');
});

test('guard: a confirmation is bound to its account, its action and its size', async () => {
  resetStore();
  const a = await seededAccount('instagram', 'one');
  const b = await seededAccount('instagram', 'two');

  const { token } = guards.createConfirmation({ accountId: a.account_id, action: 'unfollow', maxTargets: 1 });
  const wrongAccount = await guards.check({ account: b, action: 'unfollow', count: 1, confirmationToken: token });
  assert.equal(wrongAccount.ok, false);
  assert.match(wrongAccount.error, /issued for instagram:one/);

  const { token: t2 } = guards.createConfirmation({ accountId: a.account_id, action: 'unfollow', maxTargets: 1 });
  const wrongAction = await guards.check({ account: a, action: 'unfollow', count: 2, confirmationToken: t2 });
  assert.equal(wrongAction.ok, false);
  assert.match(wrongAction.error, /covers 1 target/);
});

test('guard: publishing is confirmed every time unless the account allows otherwise', async () => {
  resetStore();
  const x = await seededAccount('twitter', 'ArianaReyes');

  const blocked = await guards.check({ account: x, action: 'post', count: 1 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'needs_confirmation');

  const { token } = guards.createConfirmation({ accountId: x.account_id, action: 'post', maxTargets: 1 });
  assert.equal((await guards.check({ account: x, action: 'post', count: 1, confirmationToken: token })).ok, true);

  const autopublish = await guards.check({ account: x, action: 'post', count: 1, autopublish: true });
  assert.equal(autopublish.ok, true, 'an account the creator marked autopublish does not ask again');
});

test('guard: a two-target batch needs a confirmation, a single action does not', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'batches');
  assert.equal((await guards.check({ account, action: 'like', count: 1 })).ok, true);
  const two = await guards.check({ account, action: 'like', count: 2 });
  assert.equal(two.ok, false);
  assert.equal(two.code, 'needs_confirmation');
  assert.match(two.error, /2-target batch/);
});

test('guard: confirmations expire and are listed with their scope', async () => {
  resetStore();
  const account = await seededAccount('instagram', 'expiring');
  const out = guards.createConfirmation({ accountId: account.account_id, action: 'unfollow', maxTargets: 1, note: 'creator clicked confirm' });
  const mine = guards.listConfirmations().find((c) => c.token === out.token);
  assert.ok(mine, 'the new confirmation is listed');
  assert.equal(mine.account_id, account.account_id);
  assert.equal(mine.action, 'unfollow');
  assert.equal(mine.max_targets, 1);
  assert.ok(guards.CONFIRM_TTL_MS > 0 && guards.CONFIRM_TTL_MS <= 60 * 60 * 1000, 'confirmations should be short-lived');

  // an unknown token is refused with an explanation, never silently accepted
  const bogus = guards.consumeConfirmation('not-a-real-token', { accountId: account.account_id, action: 'unfollow', count: 1 });
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /unknown or has expired/);
});

test('manifest: the guard defaults stay conservative', () => {
  const limits = guards.defaultLimits();
  for (const action of ['dm', 'post', 'comment', 'follow', 'unfollow', 'connect']) {
    assert.ok(limits[action] <= 12, `${action} default ceiling of ${limits[action]} is not conservative`);
  }
  assert.ok(guards.BATCH_MAX <= 5, 'batch ceiling must stay small');
  assert.ok(guards.CONFIRM_ALWAYS.has('unfollow'));
  assert.ok(guards.CONFIRM_ALWAYS.has('delete_post'));
  assert.ok(guards.CONFIRM_ALWAYS.has('delete_comment'));
});
