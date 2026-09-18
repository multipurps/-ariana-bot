// social/autonomy.js
// ─────────────────────────────────────────────────────────────────────────────
// Letting Ariana look around on her own — off by default, capped, and decided
// by HER OWN brain.
//
// There is no second intelligence in this file. It gathers a handful of real
// candidates through the supported read actions (a watchlist account's recent
// posts on Instagram, a keyword search on LinkedIn), shows them to Ariana's
// existing system prompt, and asks her a single constrained question: is this
// worth engaging with, and if so, what — if anything — would you say?
//
// Whatever she answers runs through the exact same guarded tool layer as a
// conversation-triggered action: her permission switch, daily limits,
// confirmation rules and the activity log all still apply. If she says nothing
// is worth it, nothing happens — that is a valid and expected outcome.
//
// Platforms where the integration has no way to *discover* content (X has no
// search and no post listing) are skipped honestly rather than fed invented
// candidates.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const accounts = require('./accounts');
const tools = require('./tools');
const store = require('./store');
const engine = require('./engine_client');

const DEFAULT_CONFIG = {
  enabled: false,
  interval_minutes: 180,
  max_actions_per_tick: 2,
  max_candidates_per_tick: 6,
  allow_comment: true,
  allow_follow: false,
  watchlist: { instagram: [] },
  linkedin_searches: [],
  last_run_at: null,
  last_run_summary: null,
};

let brain = null;   // injected by index.js — Ariana's own prompt machinery
let timer = null;
let running = false;

function attach({ askBrain } = {}) {
  brain = askBrain || null;
}

async function getConfig() {
  const saved = await store.loadConfig();
  const cfg = (saved && saved.autonomy) || {};
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    watchlist: { ...DEFAULT_CONFIG.watchlist, ...(cfg.watchlist || {}) },
    linkedin_searches: Array.isArray(cfg.linkedin_searches) ? cfg.linkedin_searches : [],
  };
}

async function setConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...(patch || {}) };
  await store.saveConfig({ autonomy: next });
  schedule(next);
  return next;
}

// ── SCHEDULING ──────────────────────────────────────────────────────────────
// A minute-by-minute check against last_run_at, so a restart cannot cause a
// burst: if it isn't due, nothing happens.

function isDue(config) {
  if (!config.enabled) return false;
  if (!config.last_run_at) return true;
  const last = Date.parse(config.last_run_at);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= Math.max(15, Number(config.interval_minutes) || 180) * 60 * 1000;
}

function schedule(config) {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const cfg = await getConfig();
      if (!isDue(cfg) || running) return;
      await runOnce({ trigger: 'schedule' });
    } catch (e) {
      console.warn('[social] autonomy tick failed:', e.message);
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  if (config && config.enabled) console.log(`[social] autonomy: on — checking every minute, acting at most every ${config.interval_minutes} min`);
}

async function start() {
  const cfg = await getConfig();
  schedule(cfg);
  return cfg;
}

function status() {
  return { scheduled: !!timer, running };
}

// ── CANDIDATE GATHERING ─────────────────────────────────────────────────────
// Only real read actions, and only on platforms that can list content.

async function candidatesFor(account, config) {
  const out = [];
  try {
    if (account.platform === 'instagram' && account.handle) {
      // Her own recent posts are the safest place to look when the creator has
      // not named anyone: they are hers, and engaging with them is harmless.
      const handles = (config.watchlist.instagram || []).slice(0, 3);
      if (!handles.length) handles.push(account.handle);
      for (const handle of handles) {
        const res = await tools.executeTool('social_view_posts', { username: handle, account: account.account_id }, { source: 'autonomy:scan', actor: 'ariana' });
        const urls = (res && res.data && res.data[0] && res.data[0].normalized && res.data[0].normalized.posts) || [];
        for (const url of urls.slice(0, 2)) out.push({ platform: 'instagram', account_id: account.account_id, url, handle, kind: 'post' });
      }
    }

    if (account.platform === 'linkedin') {
      for (const query of (config.linkedin_searches || []).slice(0, 2)) {
        const res = await tools.executeTool('social_search', { query, account: account.account_id }, { source: 'autonomy:scan', actor: 'ariana' });
        const posts = (res && res.data && res.data[0] && res.data[0].normalized && res.data[0].normalized.posts) || [];
        for (const url of posts.slice(0, 3)) out.push({ platform: 'linkedin', account_id: account.account_id, url, query, kind: 'post' });
      }
    }
  } catch (e) {
    console.warn('[social] candidate scan failed:', e.message);
  }
  return out.slice(0, Math.max(1, config.max_candidates_per_tick || 6));
}

// ── THE DECISION ────────────────────────────────────────────────────────────
// One question to her own prompt. The instruction is deliberately narrow: she
// may do nothing, and "nothing" is the expected answer most of the time.

function decisionPrompt(candidate, account, config, allowedActions) {
  return [
    'You are looking at one thing on social media on your own time. Decide, as yourself, whether it deserves anything from you.',
    '',
    `Platform: ${candidate.platform}`,
    `Acting as: ${account.handle}`,
    candidate.url ? `Post: ${candidate.url}` : null,
    candidate.handle ? `From: @${candidate.handle}` : null,
    candidate.query ? `Found while searching: "${candidate.query}"` : null,
    '',
    `Actions available to you right now: ${allowedActions.join(', ') || 'none'}.`,
    'Most posts deserve nothing — ignoring them is normal and correct. Only act if you genuinely have something to say or a real reason to.',
    'Never write anything that reads like marketing, engagement-farming, or filler. No hashtags.',
    '',
    'Answer with JSON only, no prose, in exactly this shape:',
    '{"decide": "skip" | "like" | "comment" | "follow", "comment": "text you would post, only when deciding comment", "reason": "one short phrase for the log"}',
  ].filter((l) => l !== null).join('\n');
}

function parseDecision(text) {
  if (!text) return { decide: 'skip' };
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return { decide: 'skip', reason: 'unparseable' };
  try {
    const parsed = JSON.parse(match[0]);
    const decide = ['skip', 'like', 'comment', 'follow'].includes(parsed.decide) ? parsed.decide : 'skip';
    return { decide, comment: typeof parsed.comment === 'string' ? parsed.comment.trim().slice(0, 500) : null, reason: String(parsed.reason || '').slice(0, 120) || null };
  } catch (_) {
    return { decide: 'skip', reason: 'unparseable' };
  }
}

// ── THE PASS ────────────────────────────────────────────────────────────────

async function runOnce({ trigger = 'manual', maximum = null } = {}) {
  if (running) return { ok: false, error: 'An autonomy pass is already running.' };
  const config = await getConfig();
  if (!config.enabled && trigger !== 'manual') return { ok: true, skipped: 'autonomy is off' };

  if (!engine.configured()) {
    return { ok: false, error: 'Social engine not connected — ' + engine.configHint() };
  }
  const list = await accounts.list();
  const usable = list.filter((a) => a.actions_enabled && a.status === accounts.STATUS.ONLINE);
  if (!usable.length) {
    const summary = { considered: 0, acted: 0, skipped: 0, errors: [], detail: 'No account is enabled and verified online.' };
    await store.saveConfig({ autonomy: { ...config, last_run_at: new Date().toISOString(), last_run_summary: summary } });
    return { ok: true, ...summary };
  }
  if (!brain) return { ok: false, error: 'Autonomy has no path to Ariana\'s brain — it stays off rather than guessing.' };

  running = true;
  const summary = { considered: 0, acted: 0, skipped: 0, errors: [], actions: [] };
  try {
    const budget = Math.min(Number(maximum) || config.max_actions_per_tick || 2, config.max_actions_per_tick || 2);
    let used = 0;

    for (const account of usable) {
      if (used >= budget) break;
      const candidates = await candidatesFor(account, config);
      for (const candidate of candidates) {
        if (used >= budget) break;
        summary.considered++;

        const allowed = ['like'];
        if (config.allow_comment) allowed.push('comment');
        if (config.allow_follow) allowed.push('follow');

        let raw;
        try {
          raw = await brain({ system: decisionPrompt(candidate, account, config, allowed), user: candidate.url || 'What do you do?' });
        } catch (e) {
          summary.errors.push({ target: candidate.url, error: e.message });
          continue;
        }
        const decision = parseDecision(raw);
        if (decision.decide === 'skip') { summary.skipped++; continue; }

        let result = null;
        if (decision.decide === 'like') {
          result = await tools.executeTool('social_like', { url: candidate.url, account: account.account_id }, { source: 'autonomy', actor: 'ariana' });
        } else if (decision.decide === 'comment' && config.allow_comment && decision.comment) {
          result = await tools.executeTool('social_comment', { url: candidate.url, text: decision.comment, account: account.account_id }, { source: 'autonomy', actor: 'ariana' });
        } else if (decision.decide === 'follow' && config.allow_follow && candidate.handle) {
          result = await tools.executeTool('social_follow', { username: candidate.handle, account: account.account_id }, { source: 'autonomy', actor: 'ariana' });
        } else {
          summary.skipped++;
          continue;
        }

        if (result && result.ok) {
          used++;
          summary.acted++;
        } else if (result) {
          if (result.code === 'needs_confirmation') summary.skipped++;
          else summary.errors.push({ target: candidate.url, error: result.error });
        }
        summary.actions.push({
          target: candidate.url || candidate.handle || null,
          decision: decision.decide,
          reason: decision.reason,
          ok: !!(result && result.ok),
          code: result ? result.code || null : null,
          summary: result ? result.summary || result.error || null : null,
        });
      }
    }
  } finally {
    running = false;
  }

  await store.saveConfig({ autonomy: { ...config, last_run_at: new Date().toISOString(), last_run_summary: summary } });
  return { ok: true, ...summary };
}

module.exports = {
  DEFAULT_CONFIG,
  attach,
  start,
  status,
  getConfig,
  setConfig,
  runOnce,
  isDue,
  parseDecision,
  decisionPrompt,
};
