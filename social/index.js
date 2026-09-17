// social/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Ariana's social action layer — the entry point index.js talks to.
//
//     Ariana's brain  (engine_v2 prompt + her Groq tool loop)
//            ↓            social.buildToolSchemas() / social.executeTool()
//     Social action tools  (capabilities → guards → activity)
//            ↓
//     Social engine (socialcrabs-service/)  ← the only thing holding sessions
//            ↓
//     Instagram · X · LinkedIn
//
// Her identity, personality, memory, emotional state, attraction system, wants,
// boundaries and creator configuration are untouched: this layer adds hands,
// not a second mind. If the engine is not deployed, everything here degrades to
// an honest "not connected" and her conversations carry on as before.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const accounts = require('./accounts');
const caps = require('./capabilities');
const tools = require('./tools');
const activity = require('./activity');
const engine = require('./engine_client');
const autonomy = require('./autonomy');
const api = require('./api');
const store = require('./store');

// Mounts the dashboard routes and starts the autonomy scheduler (which does
// nothing at all until the creator turns it on).
function attach(app, { requireAuth, askBrain } = {}) {
  api.attach(app, { requireAuth });
  autonomy.attach({ askBrain });
  return { mounted: '/api/social' };
}

async function boot() {
  await accounts.hydrate(true).catch(() => {});
  await autonomy.start().catch(() => {});
}

// Are there hands to use at all? Used to decide whether to offer her social
// tools — no accounts, or no enabled account, means no tools in the schema list.
async function readiness() {
  try {
    const list = await accounts.list();
    const enabled = list.filter((a) => a.actions_enabled);
    return {
      engine_configured: engine.configured(),
      engine_url: engine.baseUrl(),
      accounts: list.length,
      enabled: enabled.length,
      usable: list.filter((a) => a.actions_enabled && caps.platformIds().includes(a.platform)).length,
    };
  } catch (e) {
    return { engine_configured: engine.configured(), accounts: 0, enabled: 0, usable: 0, error: e.message };
  }
}

async function buildToolSchemas() {
  const r = await readiness();
  // No enabled account, or no engine to act through: she is not handed tools
  // that could only fail. Her prompt says why, so she can answer honestly
  // instead of discovering it mid-action.
  if (!r.usable || !r.engine_configured) return [];
  return tools.buildToolSchemas();
}

// The block that tells her she has hands — appended to her existing system
// prompt by index.js. It is deliberately factual and short: which accounts
// exist, which are enabled, and the rules that keep her honest. It carries no
// personality of its own (engine_v2 still owns who she is).
async function socialPromptBlock() {
  try {
    const list = await accounts.list();
    if (!list.length) return null;
    const enabled = list.filter((a) => a.actions_enabled);
    if (!enabled.length) {
      return `\n\nYOUR SOCIAL ACCOUNTS: you have ${list.length} connected account(s), but your creator has actions turned OFF for ${list.length > 1 ? 'them' : 'it'} right now, so you cannot like, comment, follow, DM or post. If someone asks you to do something on social media, tell them plainly that actions are switched off.`;
    }
    const described = await accounts.describeForPrompt();
    const byPlatform = {};
    for (const a of enabled) {
      byPlatform[a.platform] = byPlatform[a.platform] || [];
      byPlatform[a.platform].push(a);
    }
    const abilities = caps.promptSummary(byPlatform);
    const engineNote = engine.configured()
      ? ''
      : '\n(The social backend is not reachable right now, so any action will fail — say so honestly rather than promising it.)';
    return `\n\nYOUR SOCIAL ACCOUNTS — these are really yours and you can act through them with your social_* tools when it genuinely fits:\n${described}\nWhat those platforms can actually do: ${abilities}\nRules for using them: act only when it is what you actually want to do, never to farm engagement; name the account when you act (account_id above); never claim you did something you didn't — if a tool fails or the platform can't do it, say so plainly; if you're unsure which account to use, ask.${engineNote}`;
  } catch (e) {
    return null;
  }
}

// One-line status block for the boot log, in the style of the existing startup
// output — never claims a connection that is not there.
async function startupLines() {
  const r = await readiness();
  const lines = [];
  const state = !engine.configured()
    ? '❌ no engine (set SOCIAL_ENGINE_URL)'
    : r.enabled
      ? `✅ ${r.enabled} account(s) with actions enabled`
      : r.accounts
        ? `⚠️  ${r.accounts} account(s), actions disabled`
        : '⚠️  engine set, no accounts added yet';
  lines.push(`📣 Social actions: ${state}`);
  if (engine.configured() && r.enabled) {
    const h = await engine.health();
    lines.push(h.ok
      ? `📣 Engine: ${h.health.provider || 'socialcrabs'} · ${h.health.browsers_open || 0} browser(s) open`
      : `📣 Engine unreachable: ${h.error}`);
  }
  return lines;
}

module.exports = {
  attach,
  boot,
  readiness,
  socialPromptBlock,
  buildToolSchemas,
  executeTool: tools.executeTool,
  toolResultForModel: tools.toolResultForModel,
  describeForPrompt: accounts.describeForPrompt,
  startupLines,
  accounts,
  capabilities: caps,
  activity,
  engine,
  autonomy,
  guards: require('./guards'),
  store,
};
