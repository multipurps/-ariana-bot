// social/tools.js
// ─────────────────────────────────────────────────────────────────────────────
// ARIANA'S HANDS.
//
// This is the only place where "Ariana decided to do something" becomes a real
// call on a real account. Her brain (engine_v2 + her Groq reply path) is
// untouched — these are tools in the same tool-calling loop she already uses
// for send_reply and browse_web. She chooses; this file executes.
//
// Rules this file enforces so nothing upstream has to remember them:
//   · one canonical action name per capability — the adapter decides how the
//     platform does it, she never sees platform-specific wiring;
//   · nothing is offered to her that the integration cannot really do
//     (schemas are generated from the capability manifest);
//   · every call resolves to exactly one account — never a guess;
//   · every call is logged, wins and failures alike.
//
// There is no second personality here. No prompt, no tone, no opinions: just
// tools and honest results.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const caps = require('./capabilities');
const accounts = require('./accounts');
const guards = require('./guards');
const activity = require('./activity');
const engine = require('./engine_client');

// ── SCHEMA GENERATION ───────────────────────────────────────────────────────

const TOOL_FOR_ACTION = {
  search: { name: 'social_search', needs: ['query'] },
  view_profile: { name: 'social_view_profile', needs: ['username'] },
  view_posts: { name: 'social_view_posts', needs: ['username'] },
  like: { name: 'social_like', needs: ['url'] },
  comment: { name: 'social_comment', needs: ['url', 'text'] },
  reply: { name: 'social_reply', needs: ['url', 'text'] },
  follow: { name: 'social_follow', needs: ['username'] },
  unfollow: { name: 'social_unfollow', needs: ['username'] },
  connect: { name: 'social_connect', needs: ['profile_url', 'note'] },
  dm: { name: 'social_dm', needs: ['username', 'message'] },
  post: { name: 'social_post', needs: ['text'] },
  repost: { name: 'social_repost', needs: ['url'] },
  engagement: { name: 'social_engagement', needs: ['username'] },
};

const ACTION_FOR_TOOL = Object.fromEntries(
  Object.entries(TOOL_FOR_ACTION).map(([action, v]) => [v.name, action])
);

const ACTION_BLURB = {
  search: 'Search posts on a platform that supports search (LinkedIn). Returns post URLs you can then read, like or comment on.',
  view_profile: "Read a public profile: name, bio, follower counts where the platform exposes them. Costs nothing and changes nothing — use it before deciding anything.",
  view_posts: 'List an account\'s recent posts (Instagram only). Returns URLs.',
  like: "Like a post through one of your own accounts. Give the post URL.",
  comment: 'Post a public comment under a post. The text is yours — write it as yourself.',
  reply: "Reply to someone's post (an X reply, or a comment where the platform treats them the same).",
  follow: 'Follow an account.',
  unfollow: 'Unfollow an account. This one always asks your creator to confirm first.',
  connect: 'Send a LinkedIn connection request, optionally with a short note.',
  dm: 'Send a direct message to someone.',
  post: 'Publish a post of your own (X only). Publishing is public and permanent, so it needs your creator\'s confirmation unless they enabled autopublish.',
  repost: "Repost / retweet someone else's post.",
  engagement: 'Check follower/following counts for an account (X only).',
};

const TOOL_ACCOUNT_PARAM = {
  type: 'string',
  description: 'Which of your accounts to act through, e.g. "instagram:ariana.personal". Always name it when the task makes it obvious; otherwise ask.',
};

function batchParam(action) {
  const spec = caps.actionSpec(action) || {};
  if (!spec.batchable) return null;
  return {
    type: 'array',
    items: { type: 'string' },
    description: `Optional extra targets (max ${guards.BATCH_MAX} total). A batch of ${guards.BATCH_CONFIRM_THRESHOLD}+ needs your creator's confirmation, so prefer one considered action over a sweep.`,
  };
}

// Builds the tool list from the manifest + connected accounts. If no account
// has actions enabled, no social tools are offered at all — she simply doesn't
// have hands right now, and her prompt says so.
async function buildToolSchemas() {
  const list = await accounts.list();
  const usable = list.filter((a) => a.actions_enabled && caps.platformIds().includes(a.platform));
  if (!usable.length) return [];

  const available = new Set();
  for (const a of usable) {
    for (const action of Object.keys(TOOL_FOR_ACTION)) {
      if (caps.supports(a.platform, action)) available.add(action);
    }
  }
  const platformsText = [...new Set(usable.map((a) => caps.platformInfo(a.platform)?.label))].join(', ');

  const tools = [];
  for (const action of available) {
    const def = TOOL_FOR_ACTION[action];
    const needs = def.needs;
    const properties = {};
    if (needs.includes('query')) properties.query = { type: 'string', description: 'What to search for.' };
    if (needs.includes('url')) properties.url = { type: 'string', description: 'Full URL of the post.' };
    if (needs.includes('username')) properties.username = { type: 'string', description: 'Handle without the @.' };
    if (needs.includes('profile_url')) properties.profile_url = { type: 'string', description: "Full URL of the person's profile." };
    if (needs.includes('text')) properties.text = { type: 'string', description: 'The exact text to publish. Write it as yourself — no stage directions, no hashtag spam.' };
    if (needs.includes('message')) properties.message = { type: 'string', description: 'The message body. Write it as yourself.' };
    if (needs.includes('note')) properties.note = { type: 'string', description: 'Optional short note.' };
    properties.account = TOOL_ACCOUNT_PARAM;

    const b = batchParam(action);
    if (b) properties.targets = b;

    // Only mention platforms that can actually do this action.
    const capable = [...new Set(usable.filter((a) => caps.supports(a.platform, action)).map((a) => caps.platformInfo(a.platform)?.label))];

    tools.push({
      type: 'function',
      function: {
        name: def.name,
        description: `${ACTION_BLURB[action]} Works on: ${capable.join(', ')}. You are currently connected on ${platformsText}. Use this when it is genuinely what you want to do — not to farm engagement.`,
        parameters: { type: 'object', properties, required: needs.filter((n) => n !== 'note' && n !== 'targets') },
      },
    });
  }

  tools.push({
    type: 'function',
    function: {
      name: 'social_accounts',
      description: 'List the social accounts you are connected through right now, which of them have actions enabled, and exactly what each platform can and cannot do. Use this before assuming an ability.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  });

  return tools;
}

// ── EXECUTION ───────────────────────────────────────────────────────────────

function payloadFor(action, args) {
  switch (action) {
    case 'search': return { query: args.query };
    case 'view_profile': return { username: args.username };
    case 'view_posts': return { username: args.username };
    case 'like': return { url: args.url };
    case 'comment':
    case 'reply': return { url: args.url, text: args.text };
    case 'follow':
    case 'unfollow': return { username: args.username };
    case 'connect': return { profileUrl: args.profile_url, note: args.note };
    case 'dm': return { username: args.username, message: args.message };
    case 'post': return { text: args.text };
    case 'repost': return { url: args.url };
    case 'engagement': return { username: args.username };
    default: return {};
  }
}

// ── READ RESULT NORMALISATION ───────────────────────────────────────────────
// Each platform answers a read in its own shape: Instagram hands back a plain
// array of post URLs, LinkedIn an object with a posts list, and profiles differ
// per platform. Her autonomy scan and anything else that consumes reads should
// not have to know that, so a successful read also carries a small `normalized`
// view of the same data. It is derived, never invented: if the platform
// returned nothing, `posts` is an empty list, not a guess.
function urlsFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item && item.url))
      .filter((u) => typeof u === 'string' && u);
  }
  if (Array.isArray(value.posts)) return urlsFrom(value.posts);
  if (typeof value.url === 'string') return [value.url];
  return [];
}

function normalizeResult(action, result) {
  if (!result || typeof result !== 'object') return null;
  const payload = result.data === undefined ? result : result.data;
  const out = {};
  if (action === 'view_posts' || action === 'search' || action === 'view_feed') {
    out.posts = urlsFrom(payload).slice(0, 50);
  } else if (action === 'view_profile' || action === 'engagement') {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) out.profile = payload;
  }
  return Object.keys(out).length ? out : null;
}

function targetOf(action, args) {
  if (action === 'search') return args.query;
  if (action === 'post') return null;
  return args.url || args.username || args.profile_url || null;
}

function handleOf(action, args) {
  if (action === 'like' || action === 'comment' || action === 'reply' || action === 'repost') return args.username || null;
  return args.username || null;
}

async function executeTool(toolName, args = {}, ctx = {}) {
  const source = ctx.source || 'chat';

  if (toolName === 'social_accounts') {
    const described = caps.describe();
    const list = await accounts.list();
    return {
      ok: true,
      action: 'accounts',
      summary: `${list.length} account(s) known`,
      data: {
        accounts: list.map((a) => ({ account_id: a.account_id, platform: a.platform, handle: a.handle, actions_enabled: a.actions_enabled, status: a.status })),
        platforms: described.platforms.map((p) => ({
          platform: p.id,
          label: p.label,
          can: p.supported.map((s) => s.action),
          cannot: p.unsupported.map((u) => ({ action: u.action, reason: u.reason })),
        })),
      },
    };
  }

  const action = ACTION_FOR_TOOL[toolName];
  if (!action) {
    return { ok: false, code: 'unknown_tool', error: `Unknown social tool "${toolName}".` };
  }

  const resolved = await accounts.resolve(ctx.accountHint || args.account, args.platform || null);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.error, action };
  }
  const account = resolved.account;

  const targets = Array.isArray(args.targets) && args.targets.length ? args.targets.filter(Boolean) : [];
  const count = targets.length ? targets.length + 1 : 1;

  const gate = await guards.check({
    account,
    action,
    count,
    confirmationToken: ctx.confirmationToken || args.confirmation_token || null,
    limits: ctx.limits || null,
    autopublish: !!account.autopublish,
  });
  if (!gate.ok) {
    const entry = await activity.record({
      account, action, target: targetOf(action, args), target_handle: handleOf(action, args),
      status: gate.status, error: gate.error, actor: ctx.actor || 'ariana', detail: { source, code: gate.code },
    });
    return { ok: false, code: gate.code, error: gate.error, status: gate.status, action, account: account.account_id, summary: entry.summary };
  }

  if (process.env.SOCIAL_DRY_RUN === '1') {
    const entry = await activity.record({
      account, action, target: targetOf(action, args), target_handle: handleOf(action, args),
      status: 'skipped', error: null, actor: ctx.actor || 'ariana',
      detail: { source, dry_run: true, would_send: payloadFor(action, args) },
    });
    return { ok: false, code: 'dry_run', error: 'Dry run — no action was sent to the platform.', action, account: account.account_id, summary: entry.summary };
  }

  if (!engine.configured()) {
    const error = 'Social engine not connected — ' + engine.configHint();
    const entry = await activity.record({
      account, action, target: targetOf(action, args), target_handle: handleOf(action, args),
      status: 'failed', error, actor: ctx.actor || 'ariana', detail: { source, code: 'not_configured' },
    });
    return { ok: false, code: 'not_configured', error, action, account: account.account_id, summary: entry.summary };
  }

  const payload = payloadFor(action, args);
  const started = Date.now();
  const results = [{ target: targetOf(action, args), ...(await engine.act(account, action, payload)) }];

  // Extra targets run sequentially with the engine's own human-paced delays —
  // never in parallel, which is exactly what "not spam" looks like in practice.
  for (const extra of targets) {
    const extraPayload = { ...payload };
    if ('url' in extraPayload) extraPayload.url = extra;
    else if ('username' in extraPayload) extraPayload.username = String(extra).replace(/^@/, '');
    else if ('profileUrl' in extraPayload) extraPayload.profileUrl = extra;
    results.push({ target: extra, ...(await engine.act(account, action, extraPayload)) });
  }

  const okCount = results.filter((r) => r.ok).length;
  const firstError = results.find((r) => !r.ok);

  const entry = await activity.record({
    account, action,
    target: targetOf(action, args),
    target_handle: handleOf(action, args),
    status: okCount > 0 ? (firstError ? 'partial' : 'completed') : 'failed',
    error: firstError ? firstError.error : null,
    actor: ctx.actor || 'ariana',
    duration_ms: Date.now() - started,
    detail: { source, result: results[0] && results[0].result ? results[0].result : null, batch: count, succeeded: okCount },
  });

  if (!okCount) {
    return { ok: false, code: firstError.code || 'action_failed', error: firstError.error, action, account: account.account_id, summary: entry.summary };
  }

  return {
    ok: true,
    action,
    account: account.account_id,
    summary: entry.summary,
    partial: !!firstError,
    data: results.map((r) => ({
      target: r.target,
      ok: r.ok,
      result: r.result || null,
      normalized: r.ok ? normalizeResult(action, r.result) : null,
      error: r.error || null,
    })),
  };
}

// What the model sees after the call — short, factual, and it never invents a
// success the engine did not report.
function toolResultForModel(result) {
  if (!result) return '[social] no result';
  if (result.ok) {
    const lines = [`[social action completed] ${result.summary}`];
    if (result.data && result.data.length && result.data[0].result) {
      lines.push('Engine returned: ' + JSON.stringify(result.data[0].result).slice(0, 800));
    }
    if (result.partial) lines.push('Note: part of the batch failed — say only what actually happened.');
    return lines.join('\n');
  }
  if (result.code === 'needs_confirmation') {
    return `[social action not sent — needs creator confirmation] ${result.error} Tell them you're waiting for your creator's okay; do not say it happened.`;
  }
  if (result.code === 'unsupported' || result.code === 'unsupported_platform') {
    return `[social action impossible on this platform] ${result.error} Tell them plainly that this integration cannot do that — do not promise it.`;
  }
  if (result.code === 'not_configured') {
    return `[social action not sent — no backend connected] ${result.error} Say you couldn't do it right now; do not claim you did.`;
  }
  return `[social action failed] ${result.summary}${result.error ? ' — ' + result.error : ''}`;
}

module.exports = {
  buildToolSchemas,
  executeTool,
  toolResultForModel,
  normalizeResult,
  TOOL_FOR_ACTION,
  ACTION_FOR_TOOL,
};
