// social/guards.js
// ─────────────────────────────────────────────────────────────────────────────
// The safety layer between Ariana's intent and a real account.
//
// Three separate questions are asked before anything leaves the building:
//
//   1. Can this platform even do it?          → capabilities.check()
//   2. Has the creator enabled actions here?  → account.actions_enabled
//   3. Is she within sane daily limits, and   → confirmation + limits below
//      does this need a human yes first?
//
// What is deliberately NOT here: invented "engagement optimisation", retry
// storms, or anything that raises throughput. Ariana is one person with hands;
// these limits exist so she stays that way, and so a mistake stays small.
//
// Limits are per account, per rolling 24h, and conservative on purpose. They can
// be raised by the creator through env vars, but every default below is the
// low end of what a human would plausibly do in a day.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const caps = require('./capabilities');
const activity = require('./activity');

const DAY_MS = 24 * 60 * 60 * 1000;

function envNumber(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

// Rolling-24h ceilings per account. Read-only actions are allowed generously —
// looking at a profile is not engagement — while outbound actions are tight.
function defaultLimits() {
  return {
    like: envNumber('SOCIAL_MAX_LIKE', 25),
    comment: envNumber('SOCIAL_MAX_COMMENT', 8),
    reply: envNumber('SOCIAL_MAX_REPLY', 8),
    follow: envNumber('SOCIAL_MAX_FOLLOW', 12),
    unfollow: envNumber('SOCIAL_MAX_UNFOLLOW', 8),
    dm: envNumber('SOCIAL_MAX_DM', 6),
    post: envNumber('SOCIAL_MAX_POST', 3),
    repost: envNumber('SOCIAL_MAX_REPOST', 10),
    connect: envNumber('SOCIAL_MAX_CONNECT', 6),
    search: envNumber('SOCIAL_MAX_SEARCH', 40),
    view_profile: envNumber('SOCIAL_MAX_VIEW_PROFILE', 80),
    view_posts: envNumber('SOCIAL_MAX_VIEW_POSTS', 80),
    view_feed: envNumber('SOCIAL_MAX_VIEW_FEED', 40),
    engagement: envNumber('SOCIAL_MAX_ENGAGEMENT', 60),
    notifications: envNumber('SOCIAL_MAX_NOTIFICATIONS', 40),
    read_dms: envNumber('SOCIAL_MAX_READ_DMS', 40),
  };
}

// A single tool call may address at most this many targets. Anything larger is
// "mass" by construction and is refused outright rather than queued.
const BATCH_MAX = envNumber('SOCIAL_BATCH_MAX', 5);

// Batches at or above this size need a creator confirmation token.
const BATCH_CONFIRM_THRESHOLD = envNumber('SOCIAL_BATCH_CONFIRM_THRESHOLD', 2);

// Actions that always need an explicit creator yes, every time, even alone.
const CONFIRM_ALWAYS = new Set(['unfollow', 'delete_post', 'delete_comment', 'read_dms']);

// ── CONFIRMATIONS ───────────────────────────────────────────────────────────
// In-memory, single-use, short-lived, scoped to one account+action. They are
// issued from the dashboard (a human, authenticated) and consumed by one tool
// call. If the process restarts the creator confirms again — that is the safe
// direction to fail.

const CONFIRM_TTL_MS = envNumber('SOCIAL_CONFIRM_TTL_MS', 10 * 60 * 1000);
const confirmations = new Map(); // token -> { account_id, action, max_targets, created_at, note }

function createConfirmation({ accountId, action, maxTargets = 1, note = null }) {
  const token = crypto.randomBytes(16).toString('hex');
  confirmations.set(token, {
    account_id: accountId || null,
    action: action || null,
    max_targets: maxTargets,
    created_at: Date.now(),
    note,
  });
  return { ok: true, token, expires_in_ms: CONFIRM_TTL_MS, scope: { account_id: accountId, action, max_targets: maxTargets } };
}

function pruneConfirmations() {
  const now = Date.now();
  for (const [token, c] of confirmations) {
    if (now - c.created_at > CONFIRM_TTL_MS) confirmations.delete(token);
  }
}

function listConfirmations() {
  pruneConfirmations();
  return [...confirmations.entries()].map(([token, c]) => ({ token, ...c }));
}

function consumeConfirmation(token, { accountId, action, count = 1 }) {
  pruneConfirmations();
  if (!token) return { ok: false, error: 'This action needs your confirmation in the dashboard first.' };
  const c = confirmations.get(token);
  if (!c) return { ok: false, error: 'That confirmation code is unknown or has expired — confirm again in the dashboard.' };
  if (c.account_id && accountId && c.account_id !== accountId) {
    return { ok: false, error: `That confirmation was issued for ${c.account_id}, not ${accountId}.` };
  }
  if (c.action && action && c.action !== action) {
    return { ok: false, error: `That confirmation was issued for a different action (${c.action}).` };
  }
  if (count > c.max_targets) {
    return { ok: false, error: `That confirmation covers ${c.max_targets} target(s); this call asks for ${count}.` };
  }
  confirmations.delete(token); // single use
  return { ok: true, confirmation: c };
}

// ── CHECKS ──────────────────────────────────────────────────────────────────

function limitsFor(account, configLimits) {
  const limits = { ...defaultLimits(), ...(configLimits || {}) };
  return limits;
}

// Returns { ok:true } or { ok:false, status, error, code } where status is the
// activity-log status the caller should record ('blocked' | 'unsupported' | ...).
async function check({ account, action, count = 1, confirmationToken = null, limits = null, autopublish = false }) {
  // 1. does the integration support it at all?
  const cap = caps.check(account.platform, action);
  if (!cap.ok) {
    return { ok: false, status: 'unsupported', code: cap.code, error: cap.error };
  }

  // 2. creator permission switch
  if (!account.actions_enabled) {
    return {
      ok: false,
      status: 'blocked',
      code: 'actions_disabled',
      error: `Actions are disabled for ${account.handle} — the creator can enable them in the dashboard (Social Accounts → ${account.platform}/${account.handle}).`,
    };
  }

  // 3. batch size
  const spec = caps.actionSpec(action) || {};
  if (count > 1 && !spec.batchable) {
    return { ok: false, status: 'blocked', code: 'not_batchable', error: `"${action}" cannot be run as a batch through this integration.` };
  }
  if (count > BATCH_MAX) {
    return {
      ok: false,
      status: 'blocked',
      code: 'batch_too_large',
      error: `Refused: ${count} targets in one call exceeds the ${BATCH_MAX}-action ceiling. Mass actions are not something Ariana does — split it into individually considered actions, or raise SOCIAL_BATCH_MAX deliberately.`,
    };
  }

  // 4. daily ceiling for this account+action
  const lim = limitsFor(account, limits);
  const dailyMax = lim[action];
  if (Number.isFinite(dailyMax)) {
    const used = await activity.countSince(DAY_MS, { accountId: account.account_id, action });
    if (used + count > dailyMax) {
      return {
        ok: false,
        status: 'blocked',
        code: 'daily_limit',
        error: `Daily limit reached for "${action}" on @${account.handle}: ${used}/${dailyMax} in the last 24h. This is Ariana's own ceiling, not a platform error — it can be raised with SOCIAL_MAX_${action.toUpperCase()}.`,
      };
    }
  }

  // 5. confirmation policy
  const needsConfirm = CONFIRM_ALWAYS.has(action)
    || (action === 'post' && !autopublish)
    || (count >= BATCH_CONFIRM_THRESHOLD && count > 1);
  if (needsConfirm) {
    const reason = CONFIRM_ALWAYS.has(action)
      ? `"${action}" is irreversible enough that it always needs a human yes.`
      : action === 'post'
        ? 'Publishing is irreversible, so it needs your confirmation (or autopublish on this account).'
        : `A ${count}-target batch needs your confirmation.`;
    const consumed = consumeConfirmation(confirmationToken, { accountId: account.account_id, action, count });
    if (!consumed.ok) {
      return { ok: false, status: 'needs_confirmation', code: 'needs_confirmation', error: `${reason} ${consumed.error}` };
    }
  }

  return { ok: true, limits: lim };
}

module.exports = {
  DAY_MS,
  BATCH_MAX,
  BATCH_CONFIRM_THRESHOLD,
  CONFIRM_ALWAYS,
  CONFIRM_TTL_MS,
  defaultLimits,
  createConfirmation,
  consumeConfirmation,
  listConfirmations,
  pruneConfirmations,
  check,
};
