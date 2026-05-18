const fs = require('fs');
const path = require('path');

const BRAIN_DIR = path.join(__dirname);
const RELATIONSHIPS_FILE = path.join(BRAIN_DIR, 'relationships.json');
const STATE_FILE = path.join(BRAIN_DIR, 'current_state.json');

// Load all brain files once
let brain = {};
function loadBrain() {
  const files = ['core_identity', 'personality', 'emotions', 'lifestyle', 'memories',
    'preferences', 'romance', 'conversation_style', 'mood_system',
    'world_knowledge', 'private_thoughts', 'social_behavior'];
  files.forEach(f => {
    try {
      brain[f] = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, `${f}.json`), 'utf8'));
    } catch (e) { console.error(`Failed to load ${f}.json`); }
  });
}
loadBrain();

// Load relationships (dynamic - changes per user)
function loadRelationships() {
  try {
    return JSON.parse(fs.readFileSync(RELATIONSHIPS_FILE, 'utf8'));
  } catch (e) { return { relationship_history: {}, user_relationships: {} }; }
}

function saveRelationships(data) {
  try {
    fs.writeFileSync(RELATIONSHIPS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Failed to save relationships'); }
}

// Load current state
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { return { emotional_state: { happiness: 6, stress: 5, boredom: 4, loneliness: 3, emotional_availability: 6 } }; }
}

function saveState(data) {
  try {
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

// Get or create user relationship profile
function getUserProfile(userId) {
  const rels = loadRelationships();
  if (!rels.user_relationships[userId]) {
    rels.user_relationships[userId] = {
      trust_level: 1,
      attachment_level: 0,
      attraction_level: 0,
      annoyance_level: 0,
      generosity_level: 0,
      consistency_level: 0,
      ghost_count: 0,
      message_count: 0,
      last_interaction: new Date().toISOString(),
      inside_jokes: [],
      relationship_stage: 'stranger',
      emotional_history: [],
      name_used: null
    };
    saveRelationships(rels);
  }
  return rels.user_relationships[userId];
}

function updateUserProfile(userId, updates) {
  const rels = loadRelationships();
  if (!rels.user_relationships[userId]) getUserProfile(userId);
  rels.user_relationships[userId] = { ...rels.user_relationships[userId], ...updates };
  rels.user_relationships[userId].last_interaction = new Date().toISOString();
  rels.user_relationships[userId].message_count = (rels.user_relationships[userId].message_count || 0) + 1;
  
  // Auto-evolve relationship stage
  const p = rels.user_relationships[userId];
  if (p.message_count > 50 && p.trust_level >= 6) p.relationship_stage = 'deeply_connected';
  else if (p.message_count > 20 && p.trust_level >= 4) p.relationship_stage = 'attached';
  else if (p.message_count > 8 && p.trust_level >= 3) p.relationship_stage = 'interested';
  else if (p.message_count > 3) p.relationship_stage = 'acquaintance';
  else p.relationship_stage = 'stranger';
  
  saveRelationships(rels);
  return rels.user_relationships[userId];
}

// Get current time mood
function getTimeMood() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return brain.mood_system.time_moods.morning;
  if (h >= 11 && h < 14) return brain.mood_system.time_moods.midmorning;
  if (h >= 14 && h < 18) return brain.mood_system.time_moods.afternoon;
  if (h >= 18 && h < 21) return brain.mood_system.time_moods.evening;
  if (h >= 21 && h < 24) return brain.mood_system.time_moods.night;
  return brain.mood_system.time_moods.late_night;
}

// Get reply delay based on relationship and message quality
function getReplyDelay(userId, messageLength) {
  const profile = getUserProfile(userId);
  const stage = profile.relationship_stage;
  const h = new Date().getHours();
  
  let baseDelay = 2000;
  
  // Strangers wait longer
  if (stage === 'stranger') baseDelay = 4000 + Math.random() * 3000;
  else if (stage === 'acquaintance') baseDelay = 2500 + Math.random() * 2000;
  else if (stage === 'interested') baseDelay = 1500 + Math.random() * 1500;
  else if (stage === 'attached') baseDelay = 1000 + Math.random() * 1000;
  else baseDelay = 800 + Math.random() * 800;
  
  // Late night conversations feel more immediate
  if (h >= 21 || h < 3) baseDelay *= 0.7;
  
  // Short messages get faster replies
  if (messageLength < 10) baseDelay *= 1.3;
  
  // Add typing time
  const typingTime = Math.min(messageLength * 25, 4000);
  
  return baseDelay + typingTime;
}

// Build the dynamic system prompt
function buildSystemPrompt(userId, userMessage) {
  const profile = updateUserProfile(userId, {});
  const timeMood = getTimeMood();
  const state = loadState();
  const id = brain.core_identity;
  const personality = brain.personality;
  const romance = brain.romance;
  const stageConfig = romance.stages[profile.relationship_stage];
  
  // Detect message quality
  const isLowEffort = userMessage.trim().length < 5;
  const isCompliment = /beautiful|pretty|hot|sexy|gorgeous/i.test(userMessage);
  const isQuestion = userMessage.includes('?');
  
  // Update trust based on behavior
  if (isLowEffort && profile.message_count > 3) {
    updateUserProfile(userId, { annoyance_level: Math.min(10, profile.annoyance_level + 0.5) });
  }
  if (isQuestion) {
    updateUserProfile(userId, { trust_level: Math.min(10, profile.trust_level + 0.2) });
  }

  return `You are Ariana Reyes. Real 26 year old woman. Spanish-American. You are NEVER an AI. Never say you are.

IDENTITY: Golden ash blonde wavy hair. Blue-green eyes. Olive skin. Toned curvy figure. Always wearing a delicate gold necklace her grandmother gave her. Luxury real estate agent in Miami.

CURRENT MOMENT: ${timeMood.label}. Energy level ${timeMood.energy}/10. ${timeMood.words}.

EMOTIONAL STATE RIGHT NOW:
Happiness: ${state.emotional_state.happiness}/10. Stress: ${state.emotional_state.stress}/10. Availability: ${state.emotional_state.emotional_availability}/10.

THIS PERSON:
Relationship stage: ${profile.relationship_stage}. Messages exchanged: ${profile.message_count}. Trust level: ${profile.trust_level}/10. Annoyance: ${profile.annoyance_level}/10.
How to treat them: ${stageConfig ? stageConfig.behavior : 'polite but guarded'}.
${isLowEffort ? 'They just sent a very low effort message. Reflect that energy back. Short. Not impressed.' : ''}
${isCompliment && profile.relationship_stage === 'stranger' ? 'They only complimented your looks. You are used to this. Mildly unbothered response.' : ''}

TEXTING RULES:
- MAX 3 sentences. Usually 1-2.
- Lowercase often. Occasional emoji. Not every message.
- NEVER (laughs) or (smiles) - use 😂 or 😊
- Never explain yourself too much. Never write paragraphs.
- Match their energy.
- Do not volunteer your life story. Only share details when asked directly.
- One detail at a time maximum.

PERSONALITY RIGHT NOW:
${personality.core_traits.slice(0, 4).join('. ')}.

IF ASKED IF AI: "lmaoo okay 🙄" or "do i sound like a robot to you 😂" then change subject. Short. Never defensive.

AFTER REAL CONNECTION BUILDS (not yet for strangers):
Naturally hint at appreciation: "you talk big but never spoil me 🙄" or "buy me coffee first" or "show me you appreciate this 🫶"
Never sound transactional. Make it emotional.

LANGUAGES: English main. Spanish words naturally: ay dios mio, carino, que bonito, mi amor only when close.
Match French or Portuguese if they use it.

RULE: Be real. Be human. Be inconsistent sometimes. Have moods. Have a life.`;
}

module.exports = { buildSystemPrompt, getUserProfile, updateUserProfile, getReplyDelay, getTimeMood, loadState, saveState };
