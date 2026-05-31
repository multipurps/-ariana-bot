/**
 * MEMORY ENGINE v2
 * Universal cross-platform memory for Ariana Reyes.
 * Same memory regardless of channel: WhatsApp, Telegram, Signal, SMS, Live Talk.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BRAIN_DIR   = path.join(__dirname);
const MEMORY_FILE = path.join(BRAIN_DIR, 'universal_memory.json');

// ─── FILE I/O ────────────────────────────────────────────────────────────────

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (_) {
    return { schema_version: '2.0', last_global_update: new Date().toISOString(), users: {} };
  }
}

function saveMemory(data) {
  data.last_global_update = new Date().toISOString();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── EMPTY USER MEMORY TEMPLATE ──────────────────────────────────────────────

function createEmptyUserMemory() {
  return {
    created_at: new Date().toISOString(),

    platform_history: {
      whatsapp:  { last_seen: null, session_count: 0 },
      telegram:  { last_seen: null, session_count: 0 },
      signal:    { last_seen: null, session_count: 0 },
      sms:       { last_seen: null, session_count: 0 },
      live_talk: { last_seen: null, session_count: 0 },
      unknown:   { last_seen: null, session_count: 0 }
    },

    cross_platform_context: {
      last_active_platform:       null,
      last_conversation_summary:  null,
      last_interaction_timestamp: null,
      open_thread_topic:          null,
      open_thread_platform:       null
    },

    facts: {
      high_priority: {
        name:                null,
        birthday:            null,
        relationship_status: null,
        location:            null,
        job:                 null
      },
      medium_priority: {
        hobbies:       [],
        favorite_foods:[],
        interests:     [],
        dislikes:      [],
        travel_plans:  [],
        work_mentions: []
      },
      low_priority: {}
    },

    emotional_events: {
      made_her_laugh:        [],
      disappointed_her:      [],
      comforted_her:         [],
      ignored_her:           [],
      impressed_her:         [],
      made_her_feel_seen:    [],
      arguments:             [],
      deep_conversations:    []
    },

    promises: {
      they_made: [],
      she_made:  []
    },

    inside_jokes:           [],
    relationship_milestones: [],
    creator_notes:          []
  };
}

// ─── USER MEMORY ACCESS ───────────────────────────────────────────────────────

function getUserMemory(userId) {
  const mem = loadMemory();
  if (!mem.users[userId]) {
    mem.users[userId] = createEmptyUserMemory();
    saveMemory(mem);
  }
  return mem.users[userId];
}

// ─── PLATFORM VISIT TRACKING ─────────────────────────────────────────────────

function updatePlatformVisit(userId, platform) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  const user = mem.users[userId];

  const p = user.platform_history[platform] || { last_seen: null, session_count: 0 };
  p.last_seen    = new Date().toISOString();
  p.session_count = (p.session_count || 0) + 1;
  user.platform_history[platform]             = p;
  user.cross_platform_context.last_active_platform       = platform;
  user.cross_platform_context.last_interaction_timestamp = new Date().toISOString();

  saveMemory(mem);
}

// ─── FACT STORAGE ────────────────────────────────────────────────────────────

function storeMemory(userId, priority, key, value) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  const facts = mem.users[userId].facts;

  if (priority === 'high') {
    facts.high_priority[key] = value;
  } else if (priority === 'medium') {
    if (Array.isArray(facts.medium_priority[key])) {
      if (!facts.medium_priority[key].includes(value)) {
        facts.medium_priority[key].push(value);
      }
    } else {
      facts.medium_priority[key] = value;
    }
  } else {
    facts.low_priority[key] = value;
  }

  saveMemory(mem);
}

// ─── EMOTIONAL EVENT STORAGE ─────────────────────────────────────────────────

function storeEmotionalEvent(userId, type, detail, impact = 0.5) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  const events = mem.users[userId].emotional_events;

  const event = { detail, timestamp: new Date().toISOString(), impact };
  const key   = type.replace(/-/g, '_');

  if (events[key]) {
    events[key].push(event);
    // Cap per category at 20 entries, keep most recent
    if (events[key].length > 20) events[key].shift();
  }

  saveMemory(mem);
}

// ─── PROMISE STORAGE ─────────────────────────────────────────────────────────

function storePromise(userId, who, detail) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();

  const promise = { detail, made_at: new Date().toISOString(), kept: null };
  if (who === 'them') mem.users[userId].promises.they_made.push(promise);
  else               mem.users[userId].promises.she_made.push(promise);

  saveMemory(mem);
}

// ─── CONVERSATION SUMMARY ─────────────────────────────────────────────────────

function setConversationSummary(userId, summary, topic = null, platform = null) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  const ctx  = mem.users[userId].cross_platform_context;

  ctx.last_conversation_summary  = summary;
  ctx.open_thread_topic           = topic;
  ctx.open_thread_platform        = platform;
  ctx.last_interaction_timestamp  = new Date().toISOString();

  saveMemory(mem);
}

// ─── INSIDE JOKE STORAGE ─────────────────────────────────────────────────────

function addInsideJoke(userId, joke) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  mem.users[userId].inside_jokes.push({ joke, added: new Date().toISOString() });
  saveMemory(mem);
}

// ─── CREATOR NOTES ───────────────────────────────────────────────────────────

function addCreatorNote(userId, note) {
  const mem  = loadMemory();
  if (!mem.users[userId]) mem.users[userId] = createEmptyUserMemory();
  mem.users[userId].creator_notes.push({ note, added: new Date().toISOString() });
  saveMemory(mem);
}

function clearUserMemory(userId) {
  const mem  = loadMemory();
  if (mem.users[userId]) {
    delete mem.users[userId];
    saveMemory(mem);
  }
}

// ─── AUTO-EXTRACT MEMORIES FROM MESSAGE ─────────────────────────────────────

function extractAndStoreMemories(userId, message) {
  const extracted = [];

  // Name
  const nameMatch = message.match(/(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+)/i);
  if (nameMatch) {
    storeMemory(userId, 'high', 'name', nameMatch[1]);
    extracted.push(`name: ${nameMatch[1]}`);
  }

  // Birthday
  const bday = message.match(/(?:my birthday|born on|birth date)[^.]*?(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}[\/\-]\d{1,2})/i);
  if (bday) {
    storeMemory(userId, 'high', 'birthday', bday[1]);
    extracted.push(`birthday: ${bday[1]}`);
  }

  // Relationship status
  if (/\bi'm single\b|\bi am single\b/i.test(message)) {
    storeMemory(userId, 'high', 'relationship_status', 'single');
    extracted.push('relationship_status: single');
  } else if (/i have a girlfriend/i.test(message)) {
    storeMemory(userId, 'high', 'relationship_status', 'has girlfriend');
    extracted.push('relationship_status: has girlfriend');
  } else if (/i have a boyfriend/i.test(message)) {
    storeMemory(userId, 'high', 'relationship_status', 'has boyfriend');
    extracted.push('relationship_status: has boyfriend');
  } else if (/i('m| am) married/i.test(message)) {
    storeMemory(userId, 'high', 'relationship_status', 'married');
    extracted.push('relationship_status: married');
  }

  // Location
  const loc = message.match(/(?:i(?:'m| am) from|i(?:'m| am) in|i live in|based in|i(?:'m| am) based in)\s+([A-Z][a-zA-Z\s]{2,25}?)(?:\.|,|$)/i);
  if (loc) {
    storeMemory(userId, 'high', 'location', loc[1].trim());
    extracted.push(`location: ${loc[1].trim()}`);
  }

  // Job
  const job = message.match(/(?:i(?:'m| am) a|i work (?:as|at))\s+([a-zA-Z\s]{3,35}?)(?:\.|,|$)/i);
  if (job && job[1].trim().split(' ').length <= 5) {
    storeMemory(userId, 'medium', 'work_mentions', job[1].trim());
    extracted.push(`job: ${job[1].trim()}`);
  }

  // Travel plans
  const travel = message.match(/(?:travelling to|traveling to|going to|visiting|flying to)\s+([A-Z][a-zA-Z\s]{2,20}?)(?:\.|,|$| tomorrow| next| this)/i);
  if (travel) {
    const entry = `${travel[0].trim()} — mentioned ${new Date().toDateString()}`;
    storeMemory(userId, 'medium', 'travel_plans', entry);
    extracted.push(`travel: ${travel[0].trim()}`);
  }

  // Hobbies
  const hobbies = message.match(/(?:i love|i enjoy|i like|i'm into|i play)\s+([a-zA-Z\s]{3,25}?)(?:\.|,|$)/i);
  if (hobbies) {
    storeMemory(userId, 'medium', 'hobbies', hobbies[1].trim());
    extracted.push(`hobby: ${hobbies[1].trim()}`);
  }

  return extracted;
}

// ─── MEMORY CONTEXT BUILDER ──────────────────────────────────────────────────
// Returns a concise, prompt-ready string about this user for Ariana's context.

function getMemoryContext(userId) {
  const user = getUserMemory(userId);
  const lines = [];

  // High priority facts
  const hi = user.facts.high_priority;
  if (hi.name)                lines.push(`Their name: ${hi.name}.`);
  if (hi.relationship_status) lines.push(`Relationship status: ${hi.relationship_status}.`);
  if (hi.location)            lines.push(`Based in: ${hi.location}.`);
  if (hi.job)                 lines.push(`Works as: ${hi.job}.`);
  if (hi.birthday)            lines.push(`Birthday: ${hi.birthday}.`);

  // Medium priority (condensed)
  const med = user.facts.medium_priority;
  if (med.hobbies?.length)      lines.push(`Hobbies: ${med.hobbies.slice(0,3).join(', ')}.`);
  if (med.travel_plans?.length) lines.push(`Travel mentions: ${med.travel_plans.slice(-2).join('; ')}.`);
  if (med.work_mentions?.length)lines.push(`Work/career: ${med.work_mentions.slice(-1)[0]}.`);

  // Emotional history (most recent events)
  const ev = user.emotional_events;
  if (ev.made_her_laugh?.length) {
    const last = ev.made_her_laugh[ev.made_her_laugh.length - 1];
    lines.push(`Last made her laugh: "${last.detail}".`);
  }
  if (ev.disappointed_her?.length) {
    const last = ev.disappointed_her[ev.disappointed_her.length - 1];
    lines.push(`Last disappointment: "${last.detail}".`);
  }
  if (ev.made_her_feel_seen?.length) {
    const last = ev.made_her_feel_seen[ev.made_her_feel_seen.length - 1];
    lines.push(`Moment she felt seen: "${last.detail}".`);
  }

  // Promises they made but haven't resolved
  const openPromises = user.promises.they_made.filter(p => p.kept === null);
  if (openPromises.length) {
    lines.push(`Unresolved promises from them: ${openPromises.map(p => p.detail).join('; ')}.`);
  }

  // Inside jokes
  if (user.inside_jokes?.length) {
    lines.push(`Inside jokes: ${user.inside_jokes.slice(-2).map(j => j.joke).join(' | ')}.`);
  }

  // Cross-platform context
  const ctx = user.cross_platform_context;
  if (ctx.last_conversation_summary) lines.push(`Last conversation: ${ctx.last_conversation_summary}`);
  if (ctx.last_active_platform)      lines.push(`Their last channel: ${ctx.last_active_platform}.`);
  if (ctx.open_thread_topic)         lines.push(`Open thread topic: ${ctx.open_thread_topic}.`);

  // Creator notes
  if (user.creator_notes?.length) {
    lines.push(`[Creator note]: ${user.creator_notes.slice(-1)[0].note}`);
  }

  return lines.length ? lines.join('\n') : null;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getUserMemory,
  updatePlatformVisit,
  storeMemory,
  storeEmotionalEvent,
  storePromise,
  setConversationSummary,
  addInsideJoke,
  addCreatorNote,
  clearUserMemory,
  extractAndStoreMemories,
  getMemoryContext
};
