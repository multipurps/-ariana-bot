// social/activity.js
// ─────────────────────────────────────────────────────────────────────────────
// The social activity log — written for a person to read, not for a console.
//
// Every entry answers: which platform, which account, what was attempted, on
// what, when, how it ended, and — when it didn't work — why, in words. Raw
// engine output is kept in `detail` for debugging but never shown as the main
// line, and server logs never leak into the UI (SOCIAL.md is explicit about it).
//
// Both the outcome and the status are derived here so every surface (dashboard,
// tool results, prompts) tells the same story about the same event.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const store = require('./store');
const caps = require('./capabilities');

const STATUS_LABEL = {
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  needs_confirmation: 'Needs your confirmation',
  unsupported: 'Not supported',
  skipped: 'Skipped',
  partial: 'Partly completed',
};

// "@someone" when we know the handle, the quoted text for a search, and
// nothing at all for a bare link — the row's own Target column shows the link,
// so the sentence stays a sentence ("Liked a post", not "Liked
// instagram.com/Cabcdefghijkl's post").
function targetLabel(target_handle, target) {
  if (target_handle) return '@' + String(target_handle).replace(/^@/, '');
  if (target && /^https?:\/\//i.test(target)) return '';
  if (target) return `"${String(target).slice(0, 40)}"`;
  return '';
}

// The human sentence for an action, past tense, in the order a person would say
// it. `failed` swaps the verb for an honest "could not".
function phrase(action, where, failed) {
  const t = where;
  const at = t ? (t.startsWith('@') ? t : t) : '';
  const on = at ? ` ${at}` : '';
  switch (action) {
    case 'like':          return failed ? `Could not like${on ? `${on}'s post` : ' the post'}` : `Liked${on ? `${on}'s post` : ' a post'}`;
    case 'comment':       return failed ? `Comment failed${on ? ` on ${at}'s post` : ''}` : `Commented on${on ? `${on}'s post` : ' a post'}`;
    case 'reply':         return failed ? `Reply failed${on ? ` to ${at}` : ''}` : `Replied to${on || ' a post'}`;
    case 'follow':        return failed ? `Could not follow${on || ' the account'}` : `Followed${on || ' the account'}`;
    case 'unfollow':      return failed ? `Could not unfollow${on || ' the account'}` : `Unfollowed${on || ' the account'}`;
    case 'dm':            return failed ? `DM to${on || ' the recipient'} failed` : `Sent a DM to${on || ' the recipient'}`;
    case 'connect':       return failed ? `Connection request to${on || ' the recipient'} failed` : `Sent a connection request to${on || ' the recipient'}`;
    case 'post':          return failed ? 'Posting failed' : 'Published a post';
    case 'repost':        return failed ? `Could not repost${on ? `${on}'s post` : ' the post'}` : `Reposted${on ? `${on}'s post` : ' a post'}`;
    case 'search':        return failed ? `Search failed${at ? ` for ${at}` : ''}` : `Searched${at ? ` for ${at}` : ''}`;
    case 'view_profile':  return failed ? `Could not read${on}'s profile` : `Checked${on}'s profile`;
    case 'view_posts':    return failed ? `Could not read${on}'s recent posts` : `Read${on}'s recent posts`;
    case 'view_feed':     return failed ? 'Could not read the feed' : 'Read the feed';
    case 'engagement':    return failed ? `Could not read engagement for${on || ' the account'}` : `Checked engagement for${on || ' the account'}`;
    case 'notifications': return failed ? 'Could not check notifications' : 'Checked notifications';
    case 'read_dms':      return failed ? 'Could not read DMs' : 'Read DMs';
    case 'delete_post':   return failed ? 'Could not delete the post' : 'Deleted a post';
    case 'delete_comment':return failed ? 'Could not delete the comment' : 'Deleted a comment';
    default:              return failed ? `${action} failed` : `${action} done`;
  }
}

// Statuses that mean "nothing actually happened".
const NO_EFFECT = new Set(['blocked', 'needs_confirmation', 'unsupported', 'skipped']);

function buildSummary(entry) {
  const where = targetLabel(entry.target_handle, entry.target);
  const label = entry.status === 'completed' || entry.status === 'partial' ? false : entry.status === 'failed';
  switch (entry.status) {
    case 'completed':
      return phrase(entry.action, where);
    case 'partial':
      return `${phrase(entry.action, where)} — partly done`;
    case 'failed':
      return phrase(entry.action, where, true);
    case 'blocked':
      return `${phrase(entry.action, where, true)} — stopped by a limit or permission`;
    case 'needs_confirmation':
      return `${phrase(entry.action, where, true)} — waiting for your confirmation`;
    case 'unsupported':
      return `${phrase(entry.action, where, true)} — not supported by ${caps.platformLabel(entry.platform)}`;
    case 'skipped':
      return `${phrase(entry.action, where)} — skipped (nothing was sent)`;
    default:
      return phrase(entry.action, where, label);
  }
}

// One line, bounded: an engine or platform error can arrive with a `require`
// stack or a wall of text attached. The reason a person needs is the first
// sentence; the rest is noise in a table cell.
function clampError(text) {
  if (!text) return null;
  const first = String(text).split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  const clean = first.replace(/\s+/g, ' ');
  return clean.length > 400 ? `${clean.slice(0, 399)}…` : clean;
}

async function record(entry) {
  const platform = entry.account ? entry.account.platform : entry.platform;
  const handle = entry.account ? entry.account.handle : entry.handle;
  const account_id = entry.account ? entry.account.account_id : entry.account_id;
  const row = {
    account_id: account_id || null,
    platform: platform || null,
    handle: handle || null,
    action: entry.action,
    target: entry.target || null,
    target_handle: entry.target_handle || null,
    status: entry.status || 'completed',
    error: clampError(entry.error),
    actor: entry.actor || 'ariana',
    duration_ms: entry.duration_ms == null ? null : entry.duration_ms,
    detail: entry.detail || null,
    created_at: new Date().toISOString(),
  };
  row.summary = buildSummary(row);
  row.status_label = STATUS_LABEL[row.status] || row.status;
  try {
    await store.appendActivity(row);
  } catch (e) {
    console.warn('[social] could not write activity:', e.message);
  }
  return row;
}

// Dashboard rows: the stored entry plus presentation-ready labels. The raw
// error stays available (the creator can expand "View details") but the default
// reading is the sentence.
async function recent(limit = 50, accountId = null) {
  const rows = await store.loadActivity(limit, accountId);
  return rows.map((r) => ({
    account_id: r.account_id,
    platform: r.platform,
    platform_label: caps.platformLabel(r.platform),
    handle: r.handle,
    action: r.action,
    target: r.target,
    target_handle: r.target_handle,
    status: r.status,
    status_label: STATUS_LABEL[r.status] || r.status,
    summary: r.summary || buildSummary(r),
    error: r.error,
    actor: r.actor,
    duration_ms: r.duration_ms,
    detail: r.detail,
    created_at: r.created_at,
  }));
}

// How many actions of this kind actually happened on this account in the window
// — the number the daily ceiling is measured against. Blocked, unsupported and
// skipped entries count for nothing because nothing ran.
async function countSince(sinceMs, { accountId = null, action = null } = {}) {
  const rows = await store.loadActivity(500, accountId);
  const cutoff = Date.now() - sinceMs;
  return rows.filter((r) => {
    if (NO_EFFECT.has(r.status)) return false;
    if (r.status !== 'completed' && r.status !== 'partial') return false;
    if (action && r.action !== action) return false;
    const ts = Date.parse(r.created_at || '');
    return Number.isFinite(ts) ? ts >= cutoff : false;
  }).length;
}

module.exports = {
  record,
  recent,
  clampError,
  countSince,
  buildSummary,
  phrase,
  STATUS_LABEL,
};
