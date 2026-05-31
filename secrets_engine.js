/**
 * SECRETS ENGINE v2
 * Controls what Ariana reveals based on trust level.
 * Information unlocks gradually — never dumped all at once.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR    = process.env.BRAIN_DIR || path.join(__dirname, 'brain');
const SECRETS_FILE = path.join(BRAIN_DIR, 'secrets.json');

// ─── FILE I/O ────────────────────────────────────────────────────────────────

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch (_) {
    return { disclosure_tiers: {} };
  }
}

// ─── TIER DETECTION ──────────────────────────────────────────────────────────

/**
 * Returns the highest tier number unlocked at this trust level.
 */
function getMaxTierForTrust(trustLevel) {
  const secrets = loadSecrets();
  let maxTier   = 0;

  for (const [tierKey, cfg] of Object.entries(secrets.disclosure_tiers)) {
    const tierNum = parseInt(tierKey.replace('tier_', ''), 10);
    if (trustLevel >= cfg.trust_required && tierNum > maxTier) {
      maxTier = tierNum;
    }
  }

  return maxTier;
}

/**
 * Returns a flat array of everything she can reveal at this trust level.
 */
function getRevealableSecrets(trustLevel) {
  const secrets   = loadSecrets();
  const revealable = [];

  for (const [, cfg] of Object.entries(secrets.disclosure_tiers)) {
    if (trustLevel >= cfg.trust_required) {
      revealable.push(...cfg.reveals);
    }
  }

  return revealable;
}

/**
 * Returns a sampling of what she can share — used for prompt context.
 * Never returns the full list (she doesn't dump everything at once).
 * Returns up to 4 items at random from the available pool.
 */
function getSampledReveals(trustLevel, count = 4) {
  const pool    = getRevealableSecrets(trustLevel);
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Given a topic/question, checks if Ariana should deflect or can answer.
 * Returns: 'answer' | 'deflect' | 'partial'
 */
function canReveal(trustLevel, topic) {
  const secrets = loadSecrets();
  const lower   = topic.toLowerCase();

  // Scan tiers from highest to lowest to find which tier the topic belongs to
  const tierOrder = Object.entries(secrets.disclosure_tiers)
    .sort(([a], [b]) => parseInt(b.replace('tier_', '')) - parseInt(a.replace('tier_', '')));

  for (const [, cfg] of tierOrder) {
    const tiersReveals = cfg.reveals.join(' ').toLowerCase();
    // Check if this topic is related to something in this tier
    const keywords = lower.split(/\s+/).filter(w => w.length > 3);
    const isRelated = keywords.some(kw => tiersReveals.includes(kw));

    if (isRelated) {
      if (trustLevel >= cfg.trust_required) return 'answer';
      if (trustLevel >= cfg.trust_required - 2) return 'partial'; // near threshold
      return 'deflect';
    }
  }

  return 'answer'; // topic not sensitive — answer freely
}

/**
 * Generates a deflection suggestion for the system prompt.
 */
function getDeflectionHint(trustLevel) {
  if (trustLevel < 2) {
    return `If asked about personal history, exes, or childhood: deflect warmly. "that's a lot for a first conversation 😏" or "don't worry about my past".`;
  }
  if (trustLevel < 5) {
    return `If asked about deep fears, emotional wounds, or vulnerabilities: "we're not that close yet 🙄" or light deflection.`;
  }
  return `You can be more open but still don't overshare. Reveal one thing. Not everything.`;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getMaxTierForTrust,
  getRevealableSecrets,
  getSampledReveals,
  canReveal,
  getDeflectionHint
};
