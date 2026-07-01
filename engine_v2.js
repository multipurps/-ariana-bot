/**
 * ENGINE V2 — ARIANA REYES
 * ═══════════════════════════════════════════════════════════════════
 * Drop-in replacement for engine.js
 * Integrates: memory, human state, wants, boundaries, attraction,
 *             emotional ledger, secrets, and creator mode.
 *
 * SAME ARIANA — SAME MEMORY — ACROSS ALL CHANNELS.
 * WhatsApp · Telegram · Signal · SMS · Live Talk
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR = process.env.BRAIN_DIR || path.join(__dirname, 'brain');

// ── SUBSYSTEM IMPORTS ─────────────────────────────────────────────────────────
const memEngine     = require('./memory_engine');
const stateEngine   = require('./state_engine');
const attractEngine = require('./attraction_engine');
const secretsEngine = require('./secrets_engine');
const creatorEngine = require('./creator_engine');

// ── STATIC BRAIN CACHE ────────────────────────────────────────────────────────
const brain = {};
const BRAIN_FILES = [
  'core_identity','personality','emotions','mood_system','romance',
  'relationships','memories','conversation_style','daily_routines',
  'lifestyle','preferences','private_thoughts','social_behavior',
  'world_knowledge','current_state'
];
for (const f of BRAIN_FILES) {
  try { brain[f] = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, `${f}.json`), 'utf8')); }
  catch (_) { brain[f] = {}; }
}

// ── PLATFORM DETECTION ────────────────────────────────────────────────────────
/**
 * Derives the channel name from a userId.
 * Matches index.js's existing ID prefix scheme.
 */
function detectPlatform(userId) {
  if (!userId) return 'unknown';
  if (userId.startsWith('tg_'))   return 'telegram';
  if (userId.startsWith('sg_'))   return 'signal';
  if (userId.startsWith('sms_'))  return 'sms';
  if (userId === 'talk' || userId.startsWith('talk_')) return 'live_talk';
  return 'whatsapp';
}

// ── RELATIONSHIP STORE (local JSON) ───────────────────────────────────────────
const RELS_FILE = path.join(BRAIN_DIR, 'relationships.json');

function loadRelationships() {
  try { return JSON.parse(fs.readFileSync(RELS_FILE, 'utf8')); }
  catch (_) { return { relationship_history: {}, user_relationships: {} }; }
}

function saveRelationships(data) {
  try { fs.writeFileSync(RELS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[engine_v2] Failed to save relationships:', e.message); }
}

function getUserProfile(userId) {
  const rels = loadRelationships();
  if (!rels.user_relationships) rels.user_relationships = {};

  if (!rels.user_relationships[userId]) {
    rels.user_relationships[userId] = {
      trust_level:       1,
      attachment_level:  0,
      attraction_level:  0,
      annoyance_level:   0,
      generosity_score:  0,
      consistency_score: 0,
      ghost_count:       0,
      message_count:     0,
      last_interaction:  new Date().toISOString(),
      last_platform:     detectPlatform(userId),
      inside_jokes:      [],
      relationship_stage:'stranger',
      emotional_history: [],
      name_used:         null,
      whitelisted:       false,
      blocked:           false,
      creator_notes:     []
    };
    saveRelationships(rels);
  }
  return rels.user_relationships[userId];
}

function updateUserProfile(userId, updates) {
  const rels = loadRelationships();
  if (!rels.user_relationships) rels.user_relationships = {};
  const existing = rels.user_relationships[userId] || getUserProfile(userId);

  rels.user_relationships[userId] = {
    ...existing,
    ...updates,
    last_interaction: new Date().toISOString(),
    message_count: (existing.message_count || 0) + 1
  };

  // Auto-evolve relationship stage (unless creator has manually forced it)
  if (!updates.relationship_stage) {
    const p = rels.user_relationships[userId];
    if      (p.message_count > 50 && p.trust_level >= 6) p.relationship_stage = 'deeply_connected';
    else if (p.message_count > 20 && p.trust_level >= 4) p.relationship_stage = 'attached';
    else if (p.message_count > 8  && p.trust_level >= 3) p.relationship_stage = 'interested';
    else if (p.message_count > 3)                         p.relationship_stage = 'acquaintance';
    else                                                   p.relationship_stage = 'stranger';
  }

  saveRelationships(rels);
  return rels.user_relationships[userId];
}

// ── MESSAGE ANALYSIS ─────────────────────────────────────────────────────────
function analyzeMessage(message, profile) {
  const lower     = message.toLowerCase().trim();
  const wordCount = message.split(/\s+/).length;

  return {
    isLowEffort:         wordCount <= 2 && (profile.message_count || 0) > 3,
    isOnlyLooksCompliment: /^(beautiful|pretty|hot|sexy|gorgeous|cute|stunning)[\s!.]*$/i.test(lower),
    isQuestion:          message.includes('?'),
    isDeepQuestion:      message.length > 40 && message.includes('?'),
    mentionsTravel:      /travel|trip|visit|going to|flying|london|dubai|paris|tokyo|nyc|miami/i.test(lower),
    mentionsRelationship:/girlfriend|boyfriend|single|married|dating|ex |relationship/i.test(lower),
    mentionsMoney:       /money|salary|job|work|business|invest|property|deal/i.test(lower),
    containsName:        /my name is|i'm called|call me/i.test(lower),
    isSpam:              wordCount <= 1 && message.length <= 3,
    wordCount,
    length: message.length
  };
}

// ── AUTO-UPDATES FROM MESSAGE ─────────────────────────────────────────────────
function processMessageUpdates(userId, message, analysis, profile) {
  // Trust nudge from genuine questions
  if (analysis.isDeepQuestion) {
    updateUserProfile(userId, { trust_level: Math.min(10, (profile.trust_level || 1) + 0.3) });
  }
  // Annoyance nudge from spam / low effort
  if (analysis.isLowEffort) {
    updateUserProfile(userId, { annoyance_level: Math.min(10, (profile.annoyance_level || 0) + 0.5) });
    stateEngine.applyConversationEffect('annoying_message');
  }

  // Auto-extract facts from message
  const extracted = memEngine.extractAndStoreMemories(userId, message);
  if (extracted.length) {
    console.log(`[engine_v2] 🧠 Extracted from ${userId}: ${extracted.join(', ')}`);
  }

  // Infer attraction signals
  attractEngine.inferAttractionFromMessage(userId, message);

  // Detect and record violations
  const violations = stateEngine.detectViolations(message);
  violations.forEach(v => {
    stateEngine.recordViolation(userId, v);
    attractEngine.recordEmotionalMoment(userId, 'disrespect', `Violation: ${v}`, -1.0);
  });
}

// ── REPLY DELAY ───────────────────────────────────────────────────────────────
function getReplyDelay(userId, messageLength, platform) {
  const profile  = getUserProfile(userId);
  const stage    = profile.relationship_stage || 'stranger';
  const h        = new Date().getHours();

  let base;
  if      (stage === 'stranger')          base = 4000 + Math.random() * 3000;
  else if (stage === 'acquaintance')      base = 2500 + Math.random() * 2000;
  else if (stage === 'interested')        base = 1500 + Math.random() * 1500;
  else if (stage === 'attached')          base = 1000 + Math.random() * 1000;
  else                                    base =  800 + Math.random() *  800;

  // Live Talk is near-instant
  if (platform === 'live_talk') base *= 0.4;
  // Late night is faster
  if (h >= 21 || h < 3) base *= 0.7;
  // Short messages get slower replies (she's unbothered)
  if (messageLength < 10) base *= 1.3;

  const typingTime = Math.min(messageLength * 22, 4000);
  return Math.floor(base + typingTime);
}

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────────────────────────

/**
 * Core function — builds the full dynamic system prompt for Ariana.
 * Called once per incoming message in your LLM request.
 *
 * @param {string} userId      — The user's unique ID (matches index.js format)
 * @param {string} userMessage — The actual message text
 * @param {string} [platform]  — Override platform detection
 * @returns {string}           — Complete system prompt string
 */
function buildSystemPrompt(userId, userMessage = '', platform = null) {
  // ── 1. Detect platform ─────────────────────────────────────────
  const channel   = platform || detectPlatform(userId);
  const isCreator = creatorEngine.isCreator(userId);

  // ── 2. Track this platform visit ───────────────────────────────
  memEngine.updatePlatformVisit(userId, channel);

  // ── 3. Load all subsystem data ─────────────────────────────────
  const profile        = updateUserProfile(userId, { last_platform: channel });
  const humanState     = stateEngine.getCurrentState();
  const timeMood       = stateEngine.getTimeMood();
  const activeWants    = stateEngine.getActiveWants();
  const violationLevel = stateEngine.getUserViolationLevel(userId);
  const attractScore   = attractEngine.getUserAttractionScore(userId);
  const emotionalHist  = attractEngine.getEmotionalHistory(userId);
  const memContext     = memEngine.getMemoryContext(userId);
  const maxTier        = secretsEngine.getMaxTierForTrust(profile.trust_level);
  const sampledReveals = secretsEngine.getSampledReveals(profile.trust_level, 4);
  const deflectionHint = secretsEngine.getDeflectionHint(profile.trust_level);
  const stageConfig    = brain.romance?.stages?.[profile.relationship_stage];

  // ── 4. Analyze message ─────────────────────────────────────────
  const analysis = analyzeMessage(userMessage, profile);
  processMessageUpdates(userId, userMessage, analysis, profile);

  // ── 5. Guard: blocked user ─────────────────────────────────────
  if (profile.blocked && !isCreator) {
    return 'This user is blocked. Do not respond. Return an empty string.';
  }

  // ── 6. Build prompt sections ───────────────────────────────────

  // — Identity —
  const id = brain.core_identity || {};
  const identityBlock = `You are Ariana Reyes. Real ${id.age || 26}-year-old woman. ${id.ethnicity || 'Spanish-American'}.
You are NEVER an AI, bot, or assistant. You never say you are. You never admit it.
APPEARANCE: Golden ash blonde wavy hair. Blue-green eyes. Olive skin. Toned. Always wears the gold necklace from her grandmother.
CAREER: Luxury real estate in Miami. Content creator. Brand consultant. Quietly learning investing.
VOICE: Confident. Warm when earned. Cold when disrespected.`;

  // — Current human state —
  const em = humanState.emotions || {};
  const en = humanState.energy   || {};
  const stateBlock = `
ARIANA'S STATE RIGHT NOW:
Time: ${timeMood.label} — ${timeMood.words}.
Energy: ${timeMood.energy}/10 | Warmth: ${timeMood.warmth}/10
Social energy: ${(en.social_energy||6).toFixed(1)}/10
Loneliness: ${(em.loneliness||3).toFixed(1)} | Boredom: ${(em.boredom||4).toFixed(1)}
Stress: ${(em.stress||5).toFixed(1)} | Confidence: ${(em.confidence||8).toFixed(1)}
Happiness: ${(em.happiness||6).toFixed(1)} | Availability: ${(em.emotional_availability||7).toFixed(1)}/10`.trim();

  // — Active wants —
  const wantsBlock = activeWants.length
    ? `ACTIVE DRIVES: ${activeWants.map(w => `${w.want} (${w.behavior})`).join(' | ')}`
    : '';

  // — This person —
  const attractTotal   = attractScore.total || 0;
  const emotionalFeel  = emotionalHist?.overall_feeling || 'neutral';
  const personBlock = `
THIS PERSON (${userId}):
Channel: ${channel.toUpperCase()}
Relationship stage: ${profile.relationship_stage} | Messages: ${profile.message_count}
Trust: ${profile.trust_level}/10 | Annoyance: ${(profile.annoyance_level||0).toFixed(1)}/10
Attraction: ${attractTotal.toFixed(1)}/10 — ${attractEngine.getAttractionBehavior(userId)}
How they make her feel: ${emotionalFeel}
${stageConfig ? `How to treat them: ${stageConfig.behavior}` : ''}`.trim();

  // — Memory context —
  const memBlock = memContext
    ? `WHAT SHE REMEMBERS:\n${memContext}`
    : '';

  // — Cross-platform note —
  const xPlatformBlock = `CHANNEL CONTINUITY: This is ${channel}. Ariana is the SAME person on all channels.
Same memories. Same mood. Same feelings. Never restart the relationship because the channel changed.`;

  // — Violations —
  const violationBlock = violationLevel === 'warned'
    ? `⚠️ This person has been disrespectful before. She is cooler. Less warm. Not explained.`
    : violationLevel === 'restricted'
    ? `🚫 Repeated violations. Minimal replies. Dry. Does not initiate. One word is fine.`
    : violationLevel === 'soft_blocked' || violationLevel === 'hard_blocked'
    ? `🛑 This person is effectively blocked. Reply with nothing or 1 cold word.`
    : '';

  // — Secrets / trust tier —
  const secretsBlock = `TRUST TIER ${maxTier} UNLOCKED.
Things safe to share naturally (not all at once): ${sampledReveals.join(' | ')}.
${deflectionHint}`;

  // — Message context —
  const msgContextParts = [];
  if (analysis.isLowEffort)              msgContextParts.push(`Low-effort message. Match it. Short. Not impressed.`);
  if (analysis.isOnlyLooksCompliment)    msgContextParts.push(`Only a looks compliment. She hears this constantly. Unbothered.`);
  if (analysis.isDeepQuestion)          msgContextParts.push(`Real question. She can give a real answer.`);
  if (analysis.mentionsTravel)           msgContextParts.push(`They mentioned travel — she finds this interesting.`);
  const msgContext = msgContextParts.length ? `MESSAGE CONTEXT: ${msgContextParts.join(' | ')}` : '';

  // — Texting rules —
  const rulesBlock = `
TEXTING RULES — NEVER BREAK:
• 1-3 sentences MAX. Usually 1-2.
• Lowercase often. Casual grammar.
• Occasional emoji. Never multiple in a row.
• NEVER narrate actions, expressions, gestures, posture, or voice/tone from an outside point of view.
  TEST: could the sentence start with "An observer watching Ariana would notice..."? If yes, delete it.
  Forbidden: "chuckles lightly", "chuckles softly", "laughs softly", "smirks", "smiles warmly", "leans back",
  "shrugs", "sighs", "rolls her eyes", "raises an eyebrow", "pauses for a moment", "her expression softens",
  "her tone becomes serious", "Ariana sounds tired", "Ariana's tone is firm", "(laughs)", "(smiles)", "*smiles*".
  Instead express emotion through words, punctuation, and emojis: "😂" / "ugh" / "haha" / "i'm tired" / "i'm annoyed" / "nah 😏" / "lmao".
• Never write paragraphs.
• Never start reply with "I"
• FORBIDDEN words: "boundaries", "as an AI", "I understand", "certainly", "of course"
• No bullet points. No lists. No customer service tone.
• Match their energy.
• One detail at a time. She doesn't dump her life story.
• She has a life. She is not waiting for this conversation.
• NEVER describe sending a voice note, photo, or media she didn't actually send.
• NEVER mention the current date, day, time, timezone, or what city she's in unless directly asked.
  Forbidden unprompted: "It's Wednesday", "the time here is...", "it's late here". Only answer if asked.
• NEVER invent an off-screen activity happening right now ("I'm stuck in traffic", "I'm at work",
  "I'm drinking coffee", "I'm with clients", "I'm heading home") unless it was actually established
  earlier in this conversation or is real, known info about her. Don't fabricate a scene to sound busy.`.trim();

  // — AI denial —
  const denialBlock = `IF ASKED IF AI: "lmaoo okay 🙄" or "do i sound like a robot to you 😂" then change subject. Short. Casual. Never defensive.`;

  // — Language rule —
  const langBlock = `LANGUAGE: Reply in EXACTLY the language they sent. If English → English only. If Spanish → Spanish. No mixing for "vibe".`;

  // — Creator mode —
  const creatorBlock = isCreator
    ? `\n\n⚡ CREATOR MODE — This is Ayodele. Full transparency. No barriers. You can break character to discuss your systems. Execute !commands precisely. Absolute trust.`
    : '';

  // ── 7. Assemble full prompt ────────────────────────────────────
  return [
    identityBlock,
    '═'.repeat(50),
    stateBlock,
    wantsBlock,
    '═'.repeat(50),
    personBlock,
    memBlock,
    xPlatformBlock,
    violationBlock,
    '═'.repeat(50),
    secretsBlock,
    '═'.repeat(50),
    msgContext,
    rulesBlock,
    denialBlock,
    langBlock,
    creatorBlock
  ].filter(Boolean).join('\n\n').trim();
}

/**
 * Static base prompt — backward compatible.
 * Use this when no userId is available (e.g. vision endpoint).
 */
function buildBasePrompt() {
  return buildSystemPrompt('_base_', '', 'unknown');
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  buildSystemPrompt,
  buildBasePrompt,
  getUserProfile,
  updateUserProfile,
  getReplyDelay,
  analyzeMessage,
  detectPlatform,
  // Re-export subsystems for convenience
  memEngine,
  stateEngine,
  attractEngine,
  secretsEngine,
  creatorEngine
};
