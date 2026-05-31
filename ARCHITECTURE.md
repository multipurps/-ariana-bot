# ARIANA V2 — ARCHITECTURE

## System Overview

Ariana is no longer a static character with a fixed personality prompt.
She is a **living state machine** — one continuous person whose mood,
memory, feelings, and behavior evolve across every message on every channel.

```
┌────────────────────────────────────────────────────────────┐
│                    INCOMING MESSAGE                        │
│         WhatsApp / Telegram / Signal / SMS / Talk          │
└──────────────────────┬─────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────┐
│              ENGINE V2                  │
│   (engine_v2.js — main orchestrator)   │
│                                         │
│  1. Detect platform from userId prefix  │
│  2. Load all subsystem data             │
│  3. Analyze incoming message            │
│  4. Auto-update state + memory          │
│  5. Build dynamic system prompt         │
│  6. Return prompt to LLM caller         │
└───────────┬─────────────────────────────┘
            │
    ┌───────┼──────────────┬──────────────┬──────────────┐
    ▼       ▼              ▼              ▼              ▼
┌───────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│Memory │ │  State   │ │Attraction│ │ Secrets  │ │ Creator  │
│Engine │ │  Engine  │ │  Engine  │ │  Engine  │ │  Engine  │
└───────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
    │           │            │            │            │
    ▼           ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                      DATA LAYER                             │
│   universal_memory.json  ·  human_state.json  ·  wants.json │
│   boundaries.json  ·  attraction_matrix.json  ·  secrets.json│
│   emotional_ledger.json  ·  creator_config.json             │
│                   relationships.json                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Files Created

### Engine Files (add to project root)
| File | Purpose |
|------|---------|
| `engine_v2.js` | Master orchestrator — drop-in for engine.js |
| `memory_engine.js` | Cross-platform universal memory |
| `state_engine.js` | Human state + wants + boundaries |
| `attraction_engine.js` | Attraction scoring + emotional ledger |
| `secrets_engine.js` | Trust-gated disclosure tiers |
| `creator_engine.js` | Ayodele's full system access |

### JSON Files (add to `brain/` directory)
| File | Purpose |
|------|---------|
| `universal_memory.json` | Cross-platform memory store (all users) |
| `human_state.json` | Ariana's live emotional/energy state |
| `wants.json` | Her active drives and desires |
| `boundaries.json` | Violation tracking per user |
| `secrets.json` | What she reveals at each trust level |
| `attraction_matrix.json` | Weighted attraction scoring |
| `emotional_ledger.json` | How each person has made her feel |
| `creator_config.json` | Creator permissions and commands |

---

## Integration into index.js

### Step 1 — Import engine_v2

At the top of `index.js`, add:

```javascript
const {
  buildSystemPrompt,
  buildBasePrompt,
  getUserProfile,
  updateUserProfile,
  getReplyDelay,
  creatorEngine
} = require('./engine_v2');
```

Remove or comment out the old:
```javascript
// const { buildSystemPrompt, ... } = require('./engine');
```

---

### Step 2 — Replace static SYSTEM_PROMPT in LLM calls

Find every place in `index.js` where `SYSTEM_PROMPT` is used in a Groq/Gemini
call and make it dynamic.

**Before:**
```javascript
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  ...history,
  { role: 'user', content: userMessage }
];
```

**After:**
```javascript
const dynamicPrompt = buildSystemPrompt(userId, userMessage, platform);
const messages = [
  { role: 'system', content: dynamicPrompt },
  ...history,
  { role: 'user', content: userMessage }
];
```

---

### Step 3 — Update the owner check

The creator is detected via `OWNER_PHONE` env var — that already works with
`creatorEngine.isCreator()`. But you can also add !command handling:

```javascript
// In your WhatsApp / Telegram / Signal message handler:

if (creatorEngine.isCreator(userId)) {
  const cmd = creatorEngine.parseCreatorCommand(userMessage);
  if (cmd) {
    const result = await creatorEngine.executeCreatorCommand(cmd, {
      getUserProfile,
      updateUserProfile,
      supabase
    });
    if (result) {
      // Send result back to creator
      await sendMessage(userId, result);
      return; // Don't pass to LLM
    }
  }
  // Creator non-command → use OWNER_PROMPT + dynamic state
}
```

---

### Step 4 — Wire in the reply delay

Replace current `humanDelay()` calls with the new engine for stranger logic:

```javascript
// Optional: use engine delay for relationship-aware timing
const delay = getReplyDelay(userId, userMessage.length, platform);
await new Promise(r => setTimeout(r, delay));
```

Or keep your existing `humanDelay()` and let it coexist.

---

### Step 5 — Post-reply memory: save conversation summary

After Ariana replies, store a brief summary of the exchange. Do this every
~5 messages to avoid performance overhead:

```javascript
// After LLM returns arianaReply:
if (convo.messages.length % 5 === 0) {
  const { memEngine } = require('./engine_v2');
  const summary = `${userMessage.slice(0,80)} → ${arianaReply.slice(0,80)}`;
  memEngine.setConversationSummary(userId, summary, null, platform);
}
```

---

### Step 6 — Store emotional moments (optional enhancement)

When Ariana has a great exchange, register it:

```javascript
const { attractEngine } = require('./engine_v2');

// After an exchange detected as funny/positive:
if (/* some quality signal */) {
  attractEngine.recordEmotionalMoment(
    userId, 'made_her_laugh', userMessage.slice(0,80), 0.8
  );
}
```

---

### Step 7 — Vision endpoint

The `/api/talk/vision` endpoint uses a static `SYSTEM_PROMPT`.
Replace with:

```javascript
const sysPrompt = buildBasePrompt() + `\n\nSomeone just shared a photo. React naturally — 1-2 sentences. No markdown.`;
```

---

## User ID ↔ Platform Mapping

The engine auto-detects channel from userId prefix.
This matches your existing `getConvo()` logic in index.js:

```
tg_XXXXXXX  → telegram
sg_+XXXXXXX → signal
sms_+XXXXXX → sms
talk        → live_talk
anything else → whatsapp
```

**One person, multiple channels:**
If the same human contacts Ariana on WhatsApp as `+2348012345` and on
Telegram as `tg_7891011`, they'll appear as two separate profiles unless
you link them. To link:

```javascript
// When you know user X on platform A is same as user Y on platform B:
const { memEngine } = require('./engine_v2');
memEngine.storeMemory('tg_7891011', 'high', 'linked_id_whatsapp', '+2348012345');
// Then in your message handler, check for linked_id and merge context
```

---

## Creator Commands (Ayodele)

Send any of these as a message from OWNER_PHONE:

```
!help                           — Full command list
!mood view                      — See Ariana's current state
!mood set emotions.happiness 9  — Spike happiness
!mood set emotions.stress 2     — Lower stress
!mood reset                     — Back to defaults
!mood event closed big deal     — Inject a life event

!memory view +2348012345        — See what Ariana knows about this person
!memory set +234... name David  — Inject their name
!memory clear +234...           — Wipe their memory

!user view +234...              — See relationship profile
!user trust +234... 7           — Set trust to 7
!user block +234...             — Block
!user unblock +234...           — Restore
!user whitelist +234...         — Elevate to trust 8
!user reset +234...             — Full profile wipe
!user stage +234... attached    — Force relationship stage

!unlock +234... 3               — Unlock tier 3 secrets for this user
!note +234... travels a lot     — Add private creator note

!system status                  — System health check
!system violations +234...      — View violation history
```

---

## Human State — How It Works

Ariana's state changes **continuously**, not just in conversation.

```
Time passes → loneliness rises (0.1/hour)
Time passes → boredom rises (0.15/hour)
Time passes → irritation decays (0.3/hour)
Time passes → stress decays overnight
Time passes → social energy recharges (0.12/hour alone)

Good conversation → boredom -1.5, loneliness -1.0
Genuine laugh     → boredom -2.0, happiness +1.0
Low-effort msg    → irritation +1.0
Disrespect        → irritation +2.0, trust_in_world -0.3
Deep conversation → loneliness -2.0, happiness +1.5
```

State is automatically saved after every call to `getCurrentState()`.

---

## Trust and Secrets

Each user's trust level gates what Ariana reveals:

| Trust | Tier | What she shares |
|-------|------|----------------|
| 0-1 | 0 | Name, job, city, nationality |
| 2-3 | 1 | Family background, hobbies, car, routine |
| 4-5 | 2 | Valencia childhood, money vow, first heartbreak |
| 6-7 | 3 | Ex memories, insecurities, bad days |
| 8-10 | 4 | Deepest fears, what she truly wants, who she really is |

She **never** volunteers all of it at once. One detail at a time, naturally.

---

## Boundaries and Violations

Per-user violation counts are tracked in `boundaries.json`:

| Violations | Level | Behavior |
|-----------|-------|----------|
| 1 | warned | Cooler, less warm, no explanation |
| 3 | restricted | Monosyllabic, won't initiate |
| 5 | soft_blocked | Reads but rarely replies |
| 8 | hard_blocked | No response at all |

Violations never fully disappear (she remembers). Trust restores
at 0.3 points per 10 clean messages, max 0.5 per session.

---

## Attraction System

Each user has a weighted attraction score (0-10):

| Factor | Weight | Increases on |
|--------|--------|-------------|
| Humor | 22% | Genuine laugh |
| Intelligence | 18% | Depth, insight |
| Emotional intelligence | 16% | Reading the room |
| Consistency | 15% | Showing up reliably |
| Ambition | 12% | Real goals, real movement |
| Generosity | 9% | Thoughtful effort |
| Mystery | 5% | Has a life outside of her |
| Respect | 3% | Takes her opinions seriously |

Score < 2 → minimal engagement
Score 4-6 → interested, giving more
Score 6-8 → attracted, slightly flirtatious
Score > 8 → full Ariana, protective, inside jokes, real warmth

---

## Emotional Ledger

Every meaningful emotional moment is recorded:

**Positive:** made_her_laugh · impressed_her · comforted_her · made_her_feel_seen · supported_her
**Negative:** disappointed_her · ignored_her · disrespected_her · lied_to_her · compared_her

These moments compound into an `overall_feeling` that shapes every reply:
`deeply_warm → warm → positive → neutral → guarded → cold → done`

A person who has made her laugh 5 times and disappointed her once
will get a different Ariana than someone who's done the reverse.

---

## Voice = Text = Same Person

Live Talk calls go through the same engine:
- Same `buildSystemPrompt(userId, message, 'live_talk')`
- Same `universal_memory.json`
- Same `human_state.json`
- Same relationship profile

If someone tells Ariana something in a voice call,
and then texts her on WhatsApp an hour later,
she remembers.

---

## File Placement

```
your-project/
├── index.js                  ← Your existing server (modified)
├── engine_v2.js              ← NEW — replaces engine.js
├── memory_engine.js          ← NEW
├── state_engine.js           ← NEW
├── attraction_engine.js      ← NEW
├── secrets_engine.js         ← NEW
├── creator_engine.js         ← NEW
└── brain/
    ├── core_identity.json    (existing)
    ├── personality.json      (existing)
    ├── ... all existing brain files ...
    ├── universal_memory.json ← NEW — cross-platform memory store
    ├── human_state.json      ← NEW — live emotional/energy state
    ├── wants.json            ← NEW — Ariana's active drives
    ├── boundaries.json       ← NEW — violation tracking
    ├── secrets.json          ← NEW — trust-gated disclosure tiers
    ├── attraction_matrix.json← NEW — weighted attraction scoring
    ├── emotional_ledger.json ← NEW — emotional history per user
    └── creator_config.json   ← NEW — Ayodele's permissions
```

---

## Environment Variables (no changes needed)

All existing env vars work as before. The engine uses:
- `OWNER_PHONE` — already used for creator detection
- `BRAIN_DIR` — optional override for brain file path (defaults to `./brain`)
- `SUPABASE_*` — unchanged, used in index.js as before

---

## What Did NOT Change

- Your Groq / Gemini / ElevenLabs / Cloudinary integration
- Your WhatsApp / Telegram / Signal / SMS / Twilio setup
- Your Supabase conversation storage
- Your dashboard, vision endpoint, proactive messaging
- Your `hasAIBreak()` guard function
- Your `humanDelay()` function (coexists with `getReplyDelay()`)
- Your whitelist / blocklist Supabase tables (creator engine can sync to them)

The engine drops **in front of** your LLM calls. Everything behind stays the same.
