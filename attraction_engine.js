/**
 * ATTRACTION ENGINE v2
 * Tracks how attracted Ariana is to each user (weighted by personality factors)
 * and how they have made her feel over time (emotional ledger).
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR       = path.join(__dirname);
const MATRIX_FILE     = path.join(BRAIN_DIR, 'attraction_matrix.json');
const LEDGER_FILE     = path.join(BRAIN_DIR, 'emotional_ledger.json');

// ─── FILE I/O ────────────────────────────────────────────────────────────────

function loadMatrix() {
  try {
    return JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
  } catch (_) {
    return { attraction_factors: {}, user_scores: {}, attraction_thresholds: {} };
  }
}

function saveMatrix(data) {
  fs.writeFileSync(MATRIX_FILE, JSON.stringify(data, null, 2));
}

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (_) {
    return { users: {} };
  }
}

function saveLedger(data) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(data, null, 2));
}

// ─── ATTRACTION SCORING ───────────────────────────────────────────────────────

function getUserAttractionScore(userId) {
  const matrix = loadMatrix();
  return matrix.user_scores[userId] || {
    total:                 0,
    humor:                 0,
    intelligence:          0,
    emotional_intelligence:0,
    consistency:           0,
    ambition:              0,
    generosity:            0,
    mystery:               0,
    respect:               0
  };
}

/**
 * Adjust a specific attraction factor for a user. Delta can be positive or negative.
 */
function updateAttractionFactor(userId, factor, delta) {
  const matrix = loadMatrix();
  if (!matrix.user_scores[userId]) {
    matrix.user_scores[userId] = { total: 0 };
  }

  const cur = matrix.user_scores[userId][factor] || 0;
  matrix.user_scores[userId][factor] = Math.max(0, Math.min(10, cur + delta));

  // Recalculate weighted total
  let total = 0;
  for (const [f, cfg] of Object.entries(matrix.attraction_factors)) {
    total += (matrix.user_scores[userId][f] || 0) * (cfg.weight || 0);
  }
  matrix.user_scores[userId].total = Math.max(0, Math.min(10, total));

  saveMatrix(matrix);
  return matrix.user_scores[userId].total;
}

/**
 * Directly set an attraction score total override (for creator use).
 */
function setAttractionOverride(userId, value) {
  const matrix = loadMatrix();
  if (!matrix.user_scores[userId]) matrix.user_scores[userId] = {};
  matrix.user_scores[userId].total    = Math.max(0, Math.min(10, value));
  matrix.user_scores[userId].override = true;
  saveMatrix(matrix);
}

/**
 * Returns a behavior description based on current attraction score.
 */
function getAttractionBehavior(userId) {
  const score = getUserAttractionScore(userId);
  const total = score.total || 0;

  if (total < 2) return 'No real interest. Politely minimal. She is not investing.';
  if (total < 4) return 'Mildly curious. Watching. Waiting to be surprised.';
  if (total < 6) return 'Interested. Giving a bit more. Starting to notice them.';
  if (total < 8) return 'Attracted. Warm. Slightly flirtatious. Looks forward to their messages.';
  return 'Deeply attracted. Rare. Full presence. Inside jokes. Real warmth. Protective.';
}

/**
 * Infer attraction signals from message content. Auto-update factors.
 */
function inferAttractionFromMessage(userId, message, responseQuality = 'neutral') {
  const lower = message.toLowerCase();

  // Humor signal
  if (/😂|lmao|haha|lol|😭/.test(message) && message.length > 15) {
    updateAttractionFactor(userId, 'humor', 0.3);
  }

  // Intelligence signal — longer, thoughtful messages with questions
  if (message.length > 80 && message.includes('?')) {
    updateAttractionFactor(userId, 'intelligence', 0.2);
  }

  // Emotional intelligence — noticing her mood, not pushing
  if (/you seem|you sound|is everything ok|how are you (really|actually)/i.test(lower)) {
    updateAttractionFactor(userId, 'emotional_intelligence', 0.4);
  }

  // Generosity signal — mentioning treating, gifts, effort
  if (/i'll|i will|let me|i want to|i'd like to/.test(lower) && /take you|get you|send you|treat you|spoil/.test(lower)) {
    updateAttractionFactor(userId, 'generosity', 0.5);
  }

  // Ambition signal
  if (/my business|i'm building|i'm working on|my company|my goal|i closed/i.test(lower)) {
    updateAttractionFactor(userId, 'ambition', 0.3);
  }

  // Mystery — short, intriguing, not over-sharing
  if (message.length < 40 && message.includes('?') === false && message.length > 5) {
    updateAttractionFactor(userId, 'mystery', 0.1);
  }

  // Respect signal — remembering something she said
  // (This is signaled externally by the engine when it detects callback references)

  // Negative: only looks compliment
  if (/^(beautiful|pretty|hot|sexy|gorgeous|cute)[\s!.]*$/i.test(message.trim())) {
    updateAttractionFactor(userId, 'respect', -0.2);
  }
}

// ─── EMOTIONAL LEDGER ────────────────────────────────────────────────────────

function createEmptyLedgerEntry() {
  return {
    positive_moments:  [],
    negative_moments:  [],
    emotional_balance: 0,
    overall_feeling:   'neutral'
  };
}

/**
 * Record an emotional moment — how this person made Ariana feel.
 */
function recordEmotionalMoment(userId, type, detail, impact) {
  const ledger = loadLedger();
  if (!ledger.users[userId]) ledger.users[userId] = createEmptyLedgerEntry();

  const moment = {
    type,
    detail,
    timestamp: new Date().toISOString(),
    impact
  };

  if (impact > 0) {
    ledger.users[userId].positive_moments.push(moment);
    if (ledger.users[userId].positive_moments.length > 30) {
      ledger.users[userId].positive_moments.shift();
    }
  } else {
    ledger.users[userId].negative_moments.push(moment);
    if (ledger.users[userId].negative_moments.length > 30) {
      ledger.users[userId].negative_moments.shift();
    }
  }

  // Recalculate balance
  const posSum = ledger.users[userId].positive_moments.reduce((s, m) => s + m.impact, 0);
  const negSum = ledger.users[userId].negative_moments.reduce((s, m) => s + Math.abs(m.impact), 0);
  ledger.users[userId].emotional_balance = posSum - negSum;

  // Determine overall feeling
  const balance = ledger.users[userId].emotional_balance;
  if      (balance >= 6)  ledger.users[userId].overall_feeling = 'deeply_warm';
  else if (balance >= 3)  ledger.users[userId].overall_feeling = 'warm';
  else if (balance >= 1)  ledger.users[userId].overall_feeling = 'positive';
  else if (balance >= -1) ledger.users[userId].overall_feeling = 'neutral';
  else if (balance >= -3) ledger.users[userId].overall_feeling = 'guarded';
  else if (balance >= -6) ledger.users[userId].overall_feeling = 'cold';
  else                    ledger.users[userId].overall_feeling = 'done';

  saveLedger(ledger);
  return ledger.users[userId];
}

function getEmotionalHistory(userId) {
  const ledger = loadLedger();
  return ledger.users[userId] || null;
}

function clearUserLedger(userId) {
  const ledger = loadLedger();
  if (ledger.users[userId]) delete ledger.users[userId];
  saveLedger(ledger);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getUserAttractionScore,
  updateAttractionFactor,
  setAttractionOverride,
  getAttractionBehavior,
  inferAttractionFromMessage,
  recordEmotionalMoment,
  getEmotionalHistory,
  clearUserLedger
};
