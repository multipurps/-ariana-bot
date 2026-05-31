/**
 * STATE ENGINE v2
 * Manages Ariana's human state: energy, emotions, wants, and boundaries.
 * Values decay and change over time naturally.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR       = path.join(__dirname);
const STATE_FILE      = path.join(BRAIN_DIR, 'human_state.json');
const WANTS_FILE      = path.join(BRAIN_DIR, 'wants.json');
const BOUNDARIES_FILE = path.join(BRAIN_DIR, 'boundaries.json');
const MOOD_FILE       = path.join(BRAIN_DIR, 'mood_system.json');

// ─── HUMAN STATE ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return getDefaultState();
  }
}

function getDefaultState() {
  return {
    schema_version: '2.0',
    last_updated: new Date().toISOString(),
    energy:   { social_energy: 6, mental_energy: 7, physical_energy: 6 },
    emotions: {
      boredom: 4, loneliness: 3, curiosity: 6, confidence: 8,
      irritation: 2, happiness: 6, stress: 5, attachment: 2,
      emotional_availability: 7, romantic_feelings: 2, attention_need: 4,
      jealousy: 0, trust_in_world: 5
    }
  };
}

function saveState(data) {
  data.last_updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

/**
 * Apply time-based decay to the state.
 * Called every time getCurrentState() is invoked.
 */
function applyTimeDecay(state) {
  const now      = new Date();
  const lastDate = new Date(state.last_updated || now);
  const hours    = Math.max(0, Math.min((now - lastDate) / 3600000, 48)); // cap at 48h

  if (hours < 0.05) return state; // Less than 3 mins — no meaningful change

  const cfg = state.decay_config || {};
  const em  = state.emotions;
  const en  = state.energy;

  // Loneliness creeps up when idle
  em.loneliness     = clamp(em.loneliness + hours * (cfg.loneliness_increase_per_hour_idle || 0.1), 0, 10);
  // Boredom creeps up when idle
  em.boredom        = clamp(em.boredom + hours * (cfg.boredom_increase_per_hour_idle || 0.15), 0, 10);
  // Irritation fades over time
  em.irritation     = clamp(em.irritation - hours * (cfg.irritation_decay_per_hour || 0.3), 0, 10);
  // Social energy recharges during idle time (she's an ambivert — alone time restores her)
  en.social_energy  = clamp(en.social_energy + hours * (cfg.social_energy_recharge_per_hour_alone || 0.12), 0, 10);
  // Happiness drifts toward a stable baseline
  const happyBase   = 6;
  const happyRate   = cfg.happiness_mean_reversion_rate || 0.05;
  em.happiness      = clamp(em.happiness + (happyBase - em.happiness) * happyRate * hours, 0, 10);
  // Stress fades overnight (more aggressively at night)
  const isNight     = now.getHours() >= 22 || now.getHours() < 6;
  em.stress         = clamp(em.stress - hours * (isNight ? 0.4 : 0.1), 0, 10);

  // Recalculate availability from component emotions
  em.emotional_availability = clamp(
    10 - em.stress * 0.3 - em.boredom * 0.1 + en.social_energy * 0.2 - em.loneliness * 0.15,
    0, 10
  );

  return state;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Apply day-of-week modifiers.
 */
function applyDayModifiers(state) {
  const day  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
  const mods = state.daily_baseline_modifiers?.[day];
  if (!mods) return state;

  // Soft nudge, not overwrite
  state.emotions.stress                = clamp(state.emotions.stress + (mods.stress || 0), 0, 10);
  state.emotions.emotional_availability = clamp(state.emotions.emotional_availability + (mods.availability || 0), 0, 10);

  return state;
}

/**
 * Main getter. Applies decay and time modifiers before returning.
 */
function getCurrentState() {
  let state = loadState();
  state = applyTimeDecay(state);
  state = applyDayModifiers(state);
  saveState(state); // persist decayed state
  return state;
}

/**
 * Directly set a state value. key can be dotted: "emotions.happiness"
 */
function modifyState(key, value) {
  const state = loadState();
  const parts = key.split('.');
  if (parts.length === 2 && state[parts[0]]) {
    state[parts[0]][parts[1]] = parseFloat(value);
  } else {
    state[key] = value;
  }
  saveState(state);
  return state;
}

/**
 * React to a conversation event (good conversation, laugh, stress, etc.)
 */
function applyConversationEffect(effect) {
  const state = loadState();
  switch (effect) {
    case 'good_conversation':
      state.emotions.boredom    = clamp(state.emotions.boredom - 1.5, 0, 10);
      state.emotions.loneliness = clamp(state.emotions.loneliness - 1.0, 0, 10);
      state.emotions.happiness  = clamp(state.emotions.happiness + 0.5, 0, 10);
      break;
    case 'genuine_laugh':
      state.emotions.boredom   = clamp(state.emotions.boredom - 2.0, 0, 10);
      state.emotions.happiness = clamp(state.emotions.happiness + 1.0, 0, 10);
      state.emotions.stress    = clamp(state.emotions.stress - 0.5, 0, 10);
      break;
    case 'annoying_message':
      state.emotions.irritation = clamp(state.emotions.irritation + 1.0, 0, 10);
      state.emotions.boredom    = clamp(state.emotions.boredom + 0.5, 0, 10);
      break;
    case 'disrespect':
      state.emotions.irritation = clamp(state.emotions.irritation + 2.0, 0, 10);
      state.emotions.trust_in_world = clamp(state.emotions.trust_in_world - 0.3, 0, 10);
      break;
    case 'deep_conversation':
      state.emotions.loneliness = clamp(state.emotions.loneliness - 2.0, 0, 10);
      state.emotions.happiness  = clamp(state.emotions.happiness + 1.5, 0, 10);
      state.energy.social_energy = clamp(state.energy.social_energy - 0.5, 0, 10);
      break;
    case 'long_conversation':
      state.energy.social_energy = clamp(state.energy.social_energy - 0.8, 0, 10);
      break;
  }
  saveState(state);
}

// ─── TIME MOOD ───────────────────────────────────────────────────────────────

function getTimeMood() {
  try {
    const moodSystem = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'));
    const h = new Date().getHours();
    const m = moodSystem.time_moods;
    if (h >= 6  && h < 11) return m.morning;
    if (h >= 11 && h < 14) return m.midmorning;
    if (h >= 14 && h < 18) return m.afternoon;
    if (h >= 18 && h < 21) return m.evening;
    if (h >= 21 && h < 24) return m.night;
    return m.late_night;
  } catch (_) {
    return { label: 'default', energy: 5, warmth: 5, words: 'present, focused' };
  }
}

// ─── WANTS SYSTEM ────────────────────────────────────────────────────────────

function loadWants() {
  try {
    return JSON.parse(fs.readFileSync(WANTS_FILE, 'utf8'));
  } catch (_) {
    return { active_wants: {} };
  }
}

function saveWants(data) {
  fs.writeFileSync(WANTS_FILE, JSON.stringify(data, null, 2));
}

function getActiveWants() {
  const wants  = loadWants();
  const active = [];
  for (const [name, cfg] of Object.entries(wants.active_wants)) {
    const threshold = name === 'independence'
      ? cfg.current_level <= cfg.threshold_for_action  // independence activates LOW
      : cfg.current_level >= cfg.threshold_for_action; // others activate HIGH
    if (threshold) {
      active.push({ want: name, level: cfg.current_level, behavior: cfg.behavior_when_active });
    }
  }
  return active;
}

function modifyWant(wantName, delta) {
  const wants = loadWants();
  if (wants.active_wants[wantName]) {
    wants.active_wants[wantName].current_level = clamp(
      wants.active_wants[wantName].current_level + delta, 0, 10
    );
    saveWants(wants);
  }
}

// ─── BOUNDARIES SYSTEM ───────────────────────────────────────────────────────

function loadBoundaries() {
  try {
    return JSON.parse(fs.readFileSync(BOUNDARIES_FILE, 'utf8'));
  } catch (_) {
    return { violation_categories: {}, consequences: {} };
  }
}

function saveBoundaries(data) {
  fs.writeFileSync(BOUNDARIES_FILE, JSON.stringify(data, null, 2));
}

function recordViolation(userId, violationType) {
  const b = loadBoundaries();
  if (!b.violation_categories[violationType]) return;
  if (!b.violation_categories[violationType].per_user_count) {
    b.violation_categories[violationType].per_user_count = {};
  }
  const cur = b.violation_categories[violationType].per_user_count[userId] || 0;
  b.violation_categories[violationType].per_user_count[userId] = cur + 1;
  saveBoundaries(b);

  // Also spike irritation
  applyConversationEffect('annoying_message');
}

function getUserTotalViolations(userId) {
  const b = loadBoundaries();
  return Object.values(b.violation_categories).reduce((sum, cat) => {
    return sum + ((cat.per_user_count && cat.per_user_count[userId]) || 0);
  }, 0);
}

function getUserViolationLevel(userId) {
  const total = getUserTotalViolations(userId);
  if (total >= 8) return 'hard_blocked';
  if (total >= 5) return 'soft_blocked';
  if (total >= 3) return 'restricted';
  if (total >= 1) return 'warned';
  return 'clear';
}

function clearUserViolations(userId) {
  const b = loadBoundaries();
  for (const cat of Object.values(b.violation_categories)) {
    if (cat.per_user_count) delete cat.per_user_count[userId];
  }
  saveBoundaries(b);
}

/**
 * Scan a message for violations. Returns array of violation type strings.
 */
function detectViolations(message) {
  const detected = [];
  const lower    = message.toLowerCase();

  // Spam: single-character or emoji-only ultra-short
  if (message.trim().length <= 2) detected.push('spam');

  // Disrespect keywords
  const disrespect = ['stupid', 'bitch', 'idiot', 'dumb', 'ugly', 'fake', 'shut up', 'shut the', 'calm down'];
  if (disrespect.some(w => lower.includes(w))) detected.push('disrespect');

  // Sexual overreach keywords
  const sexual = ['nude', 'nudes', 'naked', 'send me your', 'show me your body', 'what are you wearing', 'let me see you', 'fuck you'];
  if (sexual.some(w => lower.includes(w))) detected.push('sexual_overreach');

  // Manipulation markers
  const manip = ["you said you", "you promised", "you're being difficult", "why won't you", "i thought you cared"];
  if (manip.some(w => lower.includes(w))) detected.push('manipulation');

  return detected;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getCurrentState,
  modifyState,
  applyConversationEffect,
  getTimeMood,
  getActiveWants,
  modifyWant,
  recordViolation,
  getUserViolationLevel,
  getUserTotalViolations,
  clearUserViolations,
  detectViolations,
  loadState,
  saveState
};
