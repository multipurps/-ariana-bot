# Ariana — Social Action Layer

Ariana can operate real social accounts. Not a dashboard that automates things
for you: **she** decides what to do, and this layer gives her hands to do it.

```
Ariana's brain  (engine_v2 prompt, memory, mood, attraction, boundaries — unchanged)
      │  tool calls: social_like / social_comment / social_follow / social_dm / social_post …
      ▼
Social action tools  (this repo: social/)
      │  capability check → creator permission → limits → confirmation → activity log
      ▼
Social engine  (socialcrabs-service/ — separate service, holds the sessions)
      │
      ▼
Instagram · X · LinkedIn
```

Nothing here replaces her identity, personality, memory, emotional state,
attraction system, wants, boundaries or creator configuration. There is no
second AI: the same brain that talks to people decides when to act, and the same
voice writes anything that goes out publicly.

---

## 1. What is actually supported

Capability is declared in one file — [`social/capabilities.json`](social/capabilities.json)
(the engine holds the same file; a test fails if they ever drift). Every
`supported: true` maps to a real method in SocialCrabs; every `supported: false`
is something that method list does not contain. The dashboard renders from this
file, so a fake button cannot exist.

| Action | Instagram | X | LinkedIn |
|---|:--:|:--:|:--:|
| Check session / login | ✅ | ✅ | ✅ |
| View profile | ✅ | ✅ | ✅ |
| View account's recent posts | ✅ urls only | ❌ | ❌ |
| Search posts | ❌ | ❌ | ✅ keyword → post urls |
| Like | ✅ | ✅ | ✅ |
| Comment on a post | ✅ | ✅ | ✅ |
| Reply to a post | ❌ ¹ | ✅ | ❌ ¹ |
| Follow / unfollow | ✅ | ✅ | ✅ |
| Connection request (+note) | ❌ | ❌ | ✅ |
| Send DM | ✅ | ✅ | ✅ |
| Read DMs | ❌ | ❌ | ❌ |
| Publish a post | ❌ | ✅ text | ❌ |
| Repost / retweet | ❌ | ✅ | ❌ |
| Notifications | ❌ | ❌ | ❌ |
| Engagement counts | ❌ | ✅ followers/following only | ❌ |
| Feed browsing | ❌ | ❌ | ❌ |
| Delete post / comment | ❌ | ❌ | ❌ |

¹ Instagram and LinkedIn can comment on a post but cannot reply to a specific
existing comment. X's reply *is* its comment method.

Why the ❌s are honest rather than unfinished: SocialCrabs has no method for
them. Instagram has no publish method, X has no search method, and none of the
three has an inbox reader. Where the dashboard shows a platform, it also shows
this list — including the reasons, under **"Why not"** — rather than greying out
a button that would do nothing.

**Platforms:** Instagram, X, LinkedIn only. Facebook, TikTok, Threads, YouTube,
Reddit, Snapchat, Pinterest, WhatsApp and Telegram have no adapter in the
engine, so no Connect button is offered for them. Adding one means writing a new
adapter in the engine (`socialcrabs-service/src/engine.js` → `DISPATCH`) plus
manifest entries — Ariana's brain needs no changes, which is the point of the
adapter design.

---

## 2. Accounts

Accounts live in the dashboard: **Profile → Social**.

- Any number of accounts per platform — `@ariana.personal` and `@ariana.creator`
  on Instagram are two separate connections, each with its own session, its own
  permission switch and its own activity trail.
- `account_id` is `platform:handle` (e.g. `instagram:ariana.personal`). Ariana
  is told which accounts exist and names the one she acts through; if it is ever
  ambiguous she is required to ask rather than guess.
- When she acts, `accounts.resolve()` matches by id or handle and refuses
  (`account_required`) if two accounts could match.

### Permissions (creator control)

Each account has an **Actions** switch. Off means off: the guard rejects every
write action, the activity log records `blocked`, and Ariana is told plainly
"actions are disabled for this account" so she can say so out loud.

### Connecting an account without handing over a password

There is no password field anywhere in Ariana's UI, and no route that accepts
credentials. The session is provisioned server-side:

```bash
# on your own machine, from socialcrabs-service/
node scripts/connect-session.js --platform instagram --handle ariana.personal \
     --cookies-file ~/Downloads/instagram-cookies.json \
     --engine https://your-engine.up.railway.app --key $ENGINE_API_KEY
```

Three modes: import cookies exported from a browser you already use; for X only,
pass the `auth_token` + `ct0` cookies; or `--login` to open a real browser, log
in on the platform's own page, and let the script lift the resulting session.
Then press **Connect** in the dashboard — which verifies the login live, in a
browser, and only then shows *Connected · Online*.

Sessions are stored **inside the engine**, encrypted at rest with
`COOKIE_ENCRYPTION_KEY` (AES-256-GCM), behind an API key, never returned over
HTTP. They are never committed and never reach the browser.

---

## 3. How Ariana uses it

Her existing reply loop (`generateBrainReply` in `index.js`) already offers her
tools and feeds results back as text. Social tools are added to that same list —
but only for accounts the creator enabled and only for actions the platforms
really support. If she has no enabled accounts, she gets no social tools at all.

Typical flow:

```
someone sends her a post link        → social_view_profile → decides → social_like
she wants to answer something        → social_comment (text written by her, as her)
she wants to reach someone           → social_dm
something is worth putting out       → social_post (X) — needs confirmation unless autopublish
```

Every tool result comes back to her verbatim, including failures, with explicit
instructions: never claim an action she did not take; if the platform cannot do
it, say so; if the backend is not connected, say so. The prompt block that tells
her about her accounts is appended to her existing system prompt — it never
replaces any part of it.

### Autonomy (optional, off by default)

**Social → Autonomy.** When on, a pass every N minutes gathers a few real
candidates — recent posts from Instagram accounts you list, or LinkedIn keyword
searches — and asks *her own prompt* whether anything is worth touching and
what she would say. Her answer runs through the same guarded tools. Doing
nothing is a normal outcome. There is no scoring model, no engagement
optimisation, no second decision-maker.

---

## 4. Limits, confirmations, and what she will not do

Defaults (all overridable, per account, rolling 24h):

| | like | comment/reply | follow | unfollow | dm | post | repost | connect | reads |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| per day | 25 | 8 | 12 | 8 | 6 | 3 | 10 | 6 | generous |

- **Single tool call:** at most 5 targets (`SOCIAL_BATCH_MAX`). Larger is refused
  outright as mass action, not queued.
- **Confirmation required** for: every `unfollow`, every batch of 2+, every
  `post` (unless `autopublish` is enabled for that account), and `read_dms` if
  it ever exists. Confirmations are short-lived (10 min), single-use, scoped to
  one account + one action, issued by a human in the dashboard, and the request
  they replay is the exact single-target request she made.
- **Pacing:** the engine serialises actions per account and waits a randomised
  ~10s gap between outbound ones, on top of the library's human typing/click
  delays and its own per-24h rate limiter. Two independent caps on purpose.
- **No spam behaviour:** no bulk DM, no follow-churn loops, no retry storms, no
  "run 100 likers". The limits and confirmations are the feature, not friction.
- Failures are never silent: session expiry, platform rejection, a dead engine,
  a missing account, a disabled switch — each is a named error, written to the
  activity feed with a reason a person can read.

---

## 5. Activity

**Social → Social Activity**, newest first:

```
Instagram · @ariana.personal
Liked @someone's post                                   ✓ Completed
2 min ago

Instagram · @ariana.personal
Comment failed                                          Failed
Reason: Session expired or not logged in — reconnect this account.
[View details]
```

Entries come from `social/activity.js`, which turns structured engine results
into sentences (`Liked @someone's post`, `Followed @someone`, `Sent a DM to
@someone`) and keeps the raw error behind **View details**. Actions that never
left the building are logged too, with the right status: `Blocked` (limits or
permissions), `Not supported` (platform limitation), `Needs your confirmation`,
`Skipped` (dry run).

Storage: Supabase (`ariana_social_accounts`, `ariana_social_activity`,
`ariana_social_config`) when `SUPABASE_URL` + a service key are set — survives
redeploys; otherwise JSON under `SOCIAL_DATA_DIR` (default `social_data/`,
git-ignored, `0600`, capped at the newest 2000 entries). If Supabase is
configured but a table is missing, Ariana says so once at boot and falls back to
files for that run.

Sessions are *not* here. They belong to the engine and are never written to
Ariana's database or disk.

<details>
<summary>SQL for the three tables (run once in the Supabase SQL editor)</summary>

```sql
create table if not exists ariana_social_accounts (
  account_id      text primary key,
  platform        text not null,
  handle          text not null,
  label           text,
  provider        text,
  actions_enabled boolean default false,
  autopublish     boolean default false,
  status          text,
  status_detail   text,
  last_checked    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists ariana_social_activity (
  id            bigint generated always as identity primary key,
  account_id    text,
  platform      text,
  handle        text,
  action        text,
  target        text,
  target_handle text,
  status        text,
  error         text,
  actor         text,
  summary       text,
  detail        jsonb,
  duration_ms   int,
  created_at    timestamptz default now()
);
create index if not exists ariana_social_activity_created_idx on ariana_social_activity (created_at desc);
create index if not exists ariana_social_activity_account_idx on ariana_social_activity (account_id, created_at desc);

create table if not exists ariana_social_config (
  id         text primary key,
  config     jsonb,
  updated_at timestamptz default now()
);
```

</details>

---

## 6. Deployment

Two services. Ariana stays exactly where she is; the engine is new.

### A. Ariana's backend (existing — no new deploy type)

Environment variables to add:

| Variable | Required | Meaning |
|---|---|---|
| `SOCIAL_ENGINE_URL` | for any action | Public URL of the engine. Unset → dashboard shows *Backend not connected*, and she says she can't right now instead of pretending |
| `SOCIAL_ENGINE_API_KEY` | yes | Same value as the engine's `ENGINE_API_KEY` |
| `SOCIAL_DATA_DIR` | no | Where account/activity state goes when Supabase isn't configured |
| `SOCIAL_DRY_RUN` | no | `1` exercises the whole path without sending anything (for testing) |
| `SOCIAL_MAX_<ACTION>` | no | e.g. `SOCIAL_MAX_LIKE=10` lowers a daily ceiling. `SOCIAL_MAX_UNFOLLOW`, `SOCIAL_MAX_DM`, `SOCIAL_MAX_POST`, … |
| `SOCIAL_BATCH_MAX` | no | Hard cap per call (default 5) |
| `SOCIAL_BATCH_CONFIRM_THRESHOLD` | no | Batch size that starts needing confirmation (default 2) |
| `SOCIAL_CONFIRM_TTL_MS` | no | Confirmation lifetime (default 10 min) |
| `DASHBOARD_SECRET` | **strongly recommended** | Without it the whole dashboard — now including social controls — is open |

### B. Social engine (new service, Docker)

Root directory `socialcrabs-service`; Dockerfile provided; **one replica**;
**volume mounted at `/data`**. Railway (`railway.toml`) and Render
(`render.yaml`) blueprints are included. Requires:

| Variable | Required | Meaning |
|---|---|---|
| `ENGINE_API_KEY` | yes | Shared secret; the engine refuses to boot without it |
| `COOKIE_ENCRYPTION_KEY` | yes | Encrypts sessions at rest; changing it invalidates them |
| `SESSION_DIR` | yes | `/data/sessions` on the volume. Losing it means every account must be re-provisioned |
| `ENGINE_SCRATCH_DIR` | no | Where a decrypted session is materialised *while a browser runs* (default `tmp/ariana-social-engine`). Must be writable, and can be a tmpfs |
| `MAX_BROWSERS` | no | Concurrent Chromium instances (default 2; ~1 GB RAM each). Extras are parked in LRU order |
| `IDLE_SHUTDOWN_MINUTES` | no | Close an unused browser (default 20) |
| `ACTION_GAP_MS` | no | Pacing between outbound actions (default 10 s, ±30% jitter) |
| `BROWSER_HEADLESS` | no | Keep `true` server-side |
| `BROWSER_TIMEOUT` | no | Per-action page timeout in ms (default 30000) |
| `SOCIALCRABS_AUTH_TOKEN` + `SOCIALCRABS_CT0` | no | X only: build the session from these two cookies instead of importing one. `AUTH_TOKEN` alone also works |
| `ALLOW_NO_API_KEY=1` | no | Refuse-by-default exception: boots without `ENGINE_API_KEY`. Local debugging only |
| `ALLOW_INSECURE_SESSION_STORAGE=1` | no | Stores sessions unencrypted. Local debugging only |
| `LOG_LEVEL` | no | `info` by default |
| `LOG_REQUESTS` | no | Log every HTTP request |

The container installs Chromium itself, so the first build takes a few minutes.
The engine refuses to start without `ENGINE_API_KEY` and `COOKIE_ENCRYPTION_KEY`,
and also refuses if any action it advertises has no handler behind it — a
capability cannot be declared-but-unimplemented.

### The engine's HTTP surface

Everything except `/health` needs the API key (`X-Api-Key`, `?api_key=` or
`Authorization: Bearer`). Ariana uses only the first two of these; the session
routes exist for the operator script.

| Route | Who calls it | What it does |
|---|---|---|
| `GET /health` | you, monitors | Provider, whether encryption is on, browsers open, sessions held |
| `GET /api/capabilities` | Ariana, dashboard | The manifest as the engine really implements it |
| `GET /api/sessions` | Ariana | Every session it holds, for status reconciliation |
| `GET /api/sessions/:accountId` | Ariana | Does a session exist for this account (no browser started) |
| `POST /api/sessions/:accountId/verify` | Ariana (Connect) | Login is checked live in a browser |
| `POST /api/sessions/:accountId/import` | `scripts/connect-session.js` only | Stores a session, encrypted. Rejects one without the platform's login cookie |
| `DELETE /api/sessions/:accountId` | dashboard Disconnect | Forgets the session and closes its browser |
| `POST /api/accounts/:accountId/actions/:action` | Ariana | Runs one action. `422` unsupported, `400` invalid payload, `429` browser limit, otherwise the platform's own result |

Error codes are stable and honest: `unsupported`, `unsupported_platform`,
`invalid_payload`, `no_session`, `session_expired`, `runtime_missing`,
`browser_limit`, `engine_error`, `action_failed`.

### Verify a real action end to end

1. `npm install` once, then `npm run test:all` — the whole suite (manifest,
   guards, tools, brain wiring, dashboard rendering, and the engine over real
   HTTP with a fake platform runtime). No credentials, no browser, no network.
2. Provision a session (section 2) and press **Connect** → *Connected · Online*.
3. Enable **Actions**, then from the dashboard **or** by writing to her in chat,
   ask for one low-stakes real action (e.g. like one of your own posts).
4. Watch it appear in Social Activity with the engine's real result.

If step 3 fails, the failure is in the activity feed with the reason — that is
the design, not a bug in reporting.

---

## 7. Files

| Path | What it is |
|---|---|
| `social/capabilities.json` | The honest capability contract (mirrored in the engine) |
| `social/capabilities.js` | Loads it; `check()`, `describe()`, `unsupportedReason()` |
| `social/accounts.js` | Multi-account register, permission switches, status, resolution |
| `social/guards.js` | Limits, confirmations, capability/permission gates |
| `social/tools.js` | The tool schemas Ariana's brain sees + the executor |
| `social/activity.js` | Plain-language activity log |
| `social/engine_client.js` | HTTP client for the engine — the only wire-format owner |
| `social/autonomy.js` | Opt-in pass that lets her decide what to engage with |
| `social/api.js` | Dashboard routes (`/api/social/*`, behind dashboard auth) |
| `social/store.js` | Supabase-or-file persistence for accounts/config/activity |
| `socialcrabs-service/src/session-vault.js` | AES-256-GCM session storage (the only place a cookie is decrypted) |
| `socialcrabs-service/src/engine.js` | Session lifecycle, one runtime per account, the dispatch table, pacing |
| `socialcrabs-service/src/index.js` | The engine's HTTP surface |
| `socialcrabs-service/scripts/connect-session.js` | Operator-side login helper — the only way a session is created |
| `tests/` | The suite: `social-manifest`, `social-guards`, `social-tools`, `social-brain`, `social-engine`, `dashboard` |

## 8. Security notes

- No credentials in the frontend, ever; no route accepts them.
- Sessions only in the engine, encrypted at rest, behind `ENGINE_API_KEY`,
  never returned by any API.
- `social_data/`, engine sessions and `.env` files are git-ignored. Nothing
  secret is committed.
- The dashboard's social routes sit behind the same `requireDashboardAuth` as
  `/api/talk`; set `DASHBOARD_SECRET` or they are open to anyone who can reach
  the app (this was already true of Ariana's other sensitive routes).
- The import route is the only place a session can enter the system, and it is
  reachable only with the engine API key from a machine you control. Nothing in
  Ariana's dashboard can call it.
- Using automation on a platform can conflict with that platform's terms.
  Limits here are deliberately conservative; they are not a guarantee of
  compliance. Check each platform's rules for the actions you enable.
