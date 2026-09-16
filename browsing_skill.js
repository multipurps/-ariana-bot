// browsing_skill.js
// ─────────────────────────────────────────────────────────────────────────────
// General-purpose web browsing for Ariana, via browser-use's cloud API
// (https://browser-use.com) — a legitimate, MIT-licensed, general browser
// automation project (75k+ GitHub stars), NOT built for social-media
// engagement or bot-detection evasion. Used here for exactly one thing:
// letting her look something up or check a real page when the conversation
// needs current/external info she can't already know.
//
// Deliberately NOT wired to anything social — no liking, commenting,
// following, or posting lives in this file. That line stays where it was
// drawn earlier: a human approves anything that goes out publicly under her
// name; this module only ever returns information back into a conversation.
//
// Setup required (can't be done from here — needs your own account):
//   1. Sign up at https://cloud.browser-use.com and grab an API key
//      (cloud.browser-use.com/new-api-key)
//   2. Set BROWSER_USE_API_KEY in your Render/Railway env vars
// Without that env var, browseWeb() returns ok:false and the brain just
// answers without browsing — never a hard failure in the reply path.
// ─────────────────────────────────────────────────────────────────────────────

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.BROWSER_USE_API_KEY) return null;
  const { BrowserUse } = require('browser-use-sdk');
  client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY });
  return client;
}

// task: plain-language instruction, e.g. "check the weather in Miami today"
// Returns { ok:true, output } or { ok:false, error } — never throws, so a
// browsing failure never takes down the reply path that called it.
async function browseWeb(task) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Browsing not configured — set BROWSER_USE_API_KEY.' };
  try {
    // 90s timeout: generous enough for a real multi-step lookup, capped so
    // one slow task can't hang a reply indefinitely.
    const result = await c.run(task, { timeout: 90000 });
    return { ok: true, output: (result.output || '').toString().slice(0, 2000) };
  } catch (e) {
    console.warn('[browsing] task failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { browseWeb };
