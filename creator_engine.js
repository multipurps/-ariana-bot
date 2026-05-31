/**
 * CREATOR ENGINE v2
 * Full system access for Ayodele — the creator and architect of Ariana.
 * Parses and executes ! commands. Integrates with all subsystems.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR     = process.env.BRAIN_DIR || path.join(__dirname, 'brain');
const CREATOR_FILE  = path.join(BRAIN_DIR, 'creator_config.json');

// Lazy-loaded to avoid circular imports — loaded on first use
let _memEngine      = null;
let _stateEngine    = null;
let _attractEngine  = null;

function mem()   { return _memEngine    || (_memEngine    = require('./memory_engine')); }
function state() { return _stateEngine  || (_stateEngine  = require('./state_engine')); }
function attr()  { return _attractEngine|| (_attractEngine= require('./attraction_engine')); }

// ─── FILE I/O ────────────────────────────────────────────────────────────────

function loadCreatorConfig() {
  try {
    return JSON.parse(fs.readFileSync(CREATOR_FILE, 'utf8'));
  } catch (_) {
    return { creator: { identifier_keys: ['ayodele'], name: 'Ayodele' } };
  }
}

// ─── CREATOR DETECTION ───────────────────────────────────────────────────────

/**
 * Determines whether this userId is the creator (Ayodele).
 * Checks against:
 *  1. OWNER_PHONE env var (set in index.js)
 *  2. identifier_keys in creator_config.json
 */
function isCreator(userId) {
  if (!userId) return false;

  // Check OWNER_PHONE env var first (aligns with index.js existing logic)
  const ownerPhone = process.env.OWNER_PHONE || '';
  if (ownerPhone && (userId === ownerPhone || userId.includes(ownerPhone.replace('+', '')))) {
    return true;
  }

  // Check creator_config.json keys
  try {
    const cfg  = loadCreatorConfig();
    const keys = cfg.creator?.identifier_keys || [];
    const lId  = userId.toLowerCase();
    return keys.some(k => lId.includes(k.toLowerCase()));
  } catch (_) {
    return false;
  }
}

// ─── COMMAND PARSER ──────────────────────────────────────────────────────────

/**
 * Parse a message for creator commands (! prefix).
 * Returns null if not a command.
 */
function parseCreatorCommand(message) {
  if (!message || !message.trim().startsWith('!')) return null;
  const raw   = message.trim();
  const lower = raw.toLowerCase();

  // !memory view [userId]
  let m;
  if ((m = raw.match(/^!memory view\s+(\S+)$/i)))
    return { type: 'memory_view', userId: m[1] };

  // !memory set [userId] [key] [value]
  if ((m = raw.match(/^!memory set\s+(\S+)\s+(\S+)\s+(.+)$/i)))
    return { type: 'memory_set', userId: m[1], key: m[2], value: m[3] };

  // !memory clear [userId]
  if ((m = raw.match(/^!memory clear\s+(\S+)$/i)))
    return { type: 'memory_clear', userId: m[1] };

  // !memory summary [userId]
  if ((m = raw.match(/^!memory summary\s+(\S+)$/i)))
    return { type: 'memory_summary', userId: m[1] };

  // !mood view
  if (/^!mood view$/i.test(raw))
    return { type: 'mood_view' };

  // !mood set [key] [value]
  if ((m = raw.match(/^!mood set\s+(\S+)\s+(\S+)$/i)))
    return { type: 'mood_set', key: m[1], value: parseFloat(m[2]) };

  // !mood reset
  if (/^!mood reset$/i.test(raw))
    return { type: 'mood_reset' };

  // !mood event [description]
  if ((m = raw.match(/^!mood event\s+(.+)$/i)))
    return { type: 'mood_event', description: m[1] };

  // !user view [userId]
  if ((m = raw.match(/^!user view\s+(\S+)$/i)))
    return { type: 'user_view', userId: m[1] };

  // !user block [userId]
  if ((m = raw.match(/^!user block\s+(\S+)$/i)))
    return { type: 'user_block', userId: m[1] };

  // !user unblock [userId]
  if ((m = raw.match(/^!user unblock\s+(\S+)$/i)))
    return { type: 'user_unblock', userId: m[1] };

  // !user whitelist [userId]
  if ((m = raw.match(/^!user whitelist\s+(\S+)$/i)))
    return { type: 'user_whitelist', userId: m[1] };

  // !user reset [userId]
  if ((m = raw.match(/^!user reset\s+(\S+)$/i)))
    return { type: 'user_reset', userId: m[1] };

  // !user trust [userId] [value]
  if ((m = raw.match(/^!user trust\s+(\S+)\s+(\d+(?:\.\d+)?)$/i)))
    return { type: 'user_trust', userId: m[1], value: parseFloat(m[2]) };

  // !user stage [userId] [stage]
  if ((m = raw.match(/^!user stage\s+(\S+)\s+(\S+)$/i)))
    return { type: 'user_stage', userId: m[1], stage: m[2] };

  // !user attraction [userId] [value]
  if ((m = raw.match(/^!user attraction\s+(\S+)\s+(\d+(?:\.\d+)?)$/i)))
    return { type: 'user_attraction', userId: m[1], value: parseFloat(m[2]) };

  // !system status
  if (/^!system status$/i.test(raw))
    return { type: 'system_status' };

  // !system users
  if (/^!system users$/i.test(raw))
    return { type: 'system_users' };

  // !system violations [userId]
  if ((m = raw.match(/^!system violations\s+(\S+)$/i)))
    return { type: 'system_violations', userId: m[1] };

  // !note [userId] [note]
  if ((m = raw.match(/^!note\s+(\S+)\s+(.+)$/i)))
    return { type: 'note_add', userId: m[1], note: m[2] };

  // !unlock [userId] [tier]
  if ((m = raw.match(/^!unlock\s+(\S+)\s+(\d+)$/i)))
    return { type: 'unlock_tier', userId: m[1], tier: parseInt(m[2]) };

  // !help
  if (/^!help$/i.test(raw))
    return { type: 'help' };

  return { type: 'unknown', raw };
}

// ─── COMMAND EXECUTION ───────────────────────────────────────────────────────

/**
 * Execute a parsed creator command.
 * `getUserProfile` and `updateUserProfile` are passed in from engine_v2
 * to avoid circular require.
 */
async function executeCreatorCommand(cmd, { getUserProfile, updateUserProfile, supabase } = {}) {
  if (!cmd) return null;

  switch (cmd.type) {

    // ── MEMORY ──────────────────────────────────────────────────

    case 'memory_view': {
      const userMem = mem().getUserMemory(cmd.userId);
      const hi      = userMem.facts.high_priority;
      const ctx     = userMem.cross_platform_context;
      return [
        `📋 Memory for ${cmd.userId}:`,
        `Name: ${hi.name || '—'}`,
        `Location: ${hi.location || '—'}`,
        `Job: ${hi.job || '—'}`,
        `Relationship: ${hi.relationship_status || '—'}`,
        `Birthday: ${hi.birthday || '—'}`,
        `Hobbies: ${userMem.facts.medium_priority.hobbies?.join(', ') || '—'}`,
        `Last platform: ${ctx.last_active_platform || '—'}`,
        `Last convo: ${ctx.last_conversation_summary || '—'}`,
        `Creator notes: ${userMem.creator_notes?.map(n=>n.note).join('; ') || '—'}`
      ].join('\n');
    }

    case 'memory_set': {
      mem().storeMemory(cmd.userId, 'high', cmd.key, cmd.value);
      return `✅ Memory set — ${cmd.userId}: ${cmd.key} = "${cmd.value}"`;
    }

    case 'memory_clear': {
      mem().clearUserMemory(cmd.userId);
      return `🗑️ Memory cleared for ${cmd.userId}`;
    }

    case 'memory_summary': {
      const userMem = mem().getUserMemory(cmd.userId);
      return userMem.cross_platform_context.last_conversation_summary
        || `No conversation summary stored for ${cmd.userId}`;
    }

    // ── MOOD ────────────────────────────────────────────────────

    case 'mood_view': {
      const s  = state().getCurrentState();
      const em = s.emotions;
      const en = s.energy;
      return [
        `🧠 Current Human State:`,
        `Happiness: ${em.happiness?.toFixed(1)} | Stress: ${em.stress?.toFixed(1)}`,
        `Loneliness: ${em.loneliness?.toFixed(1)} | Boredom: ${em.boredom?.toFixed(1)}`,
        `Irritation: ${em.irritation?.toFixed(1)} | Confidence: ${em.confidence?.toFixed(1)}`,
        `Availability: ${em.emotional_availability?.toFixed(1)}`,
        `Social energy: ${en.social_energy?.toFixed(1)} | Mental: ${en.mental_energy?.toFixed(1)}`,
        `Last updated: ${s.last_updated}`
      ].join('\n');
    }

    case 'mood_set': {
      state().modifyState(cmd.key, cmd.value);
      return `✅ State updated — ${cmd.key} = ${cmd.value}`;
    }

    case 'mood_reset': {
      const defaults = {
        energy:   { social_energy: 6, mental_energy: 7, physical_energy: 6 },
        emotions: { boredom: 4, loneliness: 3, curiosity: 6, confidence: 8,
                    irritation: 2, happiness: 6, stress: 5, attachment: 2,
                    emotional_availability: 7, romantic_feelings: 2, attention_need: 4 }
      };
      defaults.last_updated = new Date().toISOString();
      state().saveState(defaults);
      return `✅ Human state reset to defaults`;
    }

    case 'mood_event': {
      const desc = (cmd.description || '').toLowerCase();
      if (/laugh|funny|joke/i.test(desc))     state().applyConversationEffect('genuine_laugh');
      if (/stress|anxious|worry/i.test(desc))  state().modifyState('emotions.stress', 8);
      if (/win|deal|closed|success/i.test(desc)){
        state().modifyState('emotions.happiness', 9);
        state().modifyState('emotions.stress', 2);
      }
      if (/sad|lonely|down/i.test(desc))       state().modifyState('emotions.loneliness', 8);
      return `✅ Mood event applied: "${cmd.description}"`;
    }

    // ── USER ────────────────────────────────────────────────────

    case 'user_view': {
      if (!getUserProfile) return 'getUserProfile not available';
      const p = getUserProfile(cmd.userId);
      return [
        `👤 Profile: ${cmd.userId}`,
        `Stage: ${p.relationship_stage} | Messages: ${p.message_count}`,
        `Trust: ${p.trust_level}/10 | Annoyance: ${p.annoyance_level}/10`,
        `Blocked: ${p.blocked ? 'YES' : 'no'} | Whitelisted: ${p.whitelisted ? 'YES' : 'no'}`,
        `Last platform: ${p.last_platform || '—'}`,
        `Last seen: ${p.last_interaction}`
      ].join('\n');
    }

    case 'user_block': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      updateUserProfile(cmd.userId, { blocked: true });
      // Also sync to Supabase if available
      if (supabase) {
        await supabase.from('ariana_blocked').upsert({ phone: cmd.userId }, { onConflict: 'phone' }).catch(()=>{});
      }
      return `🚫 ${cmd.userId} blocked`;
    }

    case 'user_unblock': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      updateUserProfile(cmd.userId, { blocked: false });
      if (supabase) {
        await supabase.from('ariana_blocked').delete().eq('phone', cmd.userId).catch(()=>{});
      }
      return `✅ ${cmd.userId} unblocked`;
    }

    case 'user_whitelist': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      updateUserProfile(cmd.userId, { whitelisted: true, trust_level: 8 });
      if (supabase) {
        await supabase.from('ariana_friends').upsert({ phone: cmd.userId }, { onConflict: 'phone' }).catch(()=>{});
      }
      return `⭐ ${cmd.userId} whitelisted — trust set to 8`;
    }

    case 'user_reset': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      mem().clearUserMemory(cmd.userId);
      attr().clearUserLedger(cmd.userId);
      state().clearUserViolations(cmd.userId);
      updateUserProfile(cmd.userId, {
        trust_level: 1, attachment_level: 0, attraction_level: 0,
        annoyance_level: 0, message_count: 0, blocked: false,
        whitelisted: false, relationship_stage: 'stranger'
      });
      return `🔄 ${cmd.userId} fully reset`;
    }

    case 'user_trust': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      updateUserProfile(cmd.userId, { trust_level: Math.min(10, Math.max(0, cmd.value)) });
      return `✅ Trust for ${cmd.userId} set to ${cmd.value}`;
    }

    case 'user_stage': {
      const validStages = ['stranger','acquaintance','interested','attached','deeply_connected'];
      if (!validStages.includes(cmd.stage)) return `❌ Invalid stage. Options: ${validStages.join(', ')}`;
      if (!updateUserProfile) return 'updateUserProfile not available';
      updateUserProfile(cmd.userId, { relationship_stage: cmd.stage });
      return `✅ ${cmd.userId} relationship stage set to "${cmd.stage}"`;
    }

    case 'user_attraction': {
      attr().setAttractionOverride(cmd.userId, cmd.value);
      return `✅ Attraction for ${cmd.userId} set to ${cmd.value}/10`;
    }

    // ── SYSTEM ──────────────────────────────────────────────────

    case 'system_status': {
      const humanState = state().getCurrentState();
      const wants      = state().getActiveWants();
      return [
        `⚡ ARIANA SYSTEM STATUS`,
        `Happiness: ${humanState.emotions.happiness?.toFixed(1)} | Stress: ${humanState.emotions.stress?.toFixed(1)}`,
        `Availability: ${humanState.emotions.emotional_availability?.toFixed(1)}`,
        `Active wants: ${wants.map(w=>w.want).join(', ') || 'none'}`,
        `Time: ${new Date().toLocaleTimeString()}`
      ].join('\n');
    }

    case 'system_users': {
      if (!getUserProfile) return 'getUserProfile not available';
      return 'Use the dashboard /api/contacts to see all users.';
    }

    case 'system_violations': {
      const total = state().getUserTotalViolations(cmd.userId);
      const level = state().getUserViolationLevel(cmd.userId);
      return `⚠️ ${cmd.userId} — violations: ${total}, level: ${level}`;
    }

    // ── EXTRAS ──────────────────────────────────────────────────

    case 'note_add': {
      mem().addCreatorNote(cmd.userId, cmd.note);
      return `📝 Note added for ${cmd.userId}: "${cmd.note}"`;
    }

    case 'unlock_tier': {
      if (!updateUserProfile) return 'updateUserProfile not available';
      const trustMap = { 0: 0, 1: 2, 2: 4, 3: 6, 4: 8 };
      const trust    = trustMap[cmd.tier] || 0;
      updateUserProfile(cmd.userId, { trust_level: trust });
      return `🔓 Tier ${cmd.tier} unlocked for ${cmd.userId} — trust set to ${trust}`;
    }

    case 'help': {
      return [
        `⚡ CREATOR COMMANDS:`,
        `!memory view [id]        — See what Ariana knows about someone`,
        `!memory set [id] [k] [v] — Inject a memory fact`,
        `!memory clear [id]       — Wipe all memories`,
        `!mood view               — See Ariana's current state`,
        `!mood set [key] [value]  — e.g. !mood set emotions.happiness 9`,
        `!mood reset              — Reset to defaults`,
        `!mood event [desc]       — Apply mood event`,
        `!user view [id]          — See user profile`,
        `!user block/unblock [id] — Block or restore`,
        `!user whitelist [id]     — Elevate trust to 8`,
        `!user trust [id] [0-10]  — Set trust level`,
        `!user stage [id] [stage] — Set relationship stage`,
        `!user reset [id]         — Full wipe`,
        `!system status           — System health`,
        `!unlock [id] [0-4]       — Force open a secrets tier`,
        `!note [id] [note]        — Add private creator note`
      ].join('\n');
    }

    case 'unknown':
    default:
      return `❓ Unknown command: "${cmd.raw || cmd.type}". Type !help for commands.`;
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  isCreator,
  parseCreatorCommand,
  executeCreatorCommand
};
