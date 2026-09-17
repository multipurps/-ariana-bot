# Ariana — Social Engine

The hands of Ariana's social layer. It holds real login sessions in real
browsers and performs the actions [SocialCrabs](https://github.com/adolfousier/socialcrabs)
implements on **Instagram, X (Twitter) and LinkedIn** — nothing more, and
nothing invented.

Ariana's brain lives in the main Ariana project. This service is deliberately
separate: it needs Chromium, it needs a persistent volume, and a browser crash
must never be able to take her conversations down. She talks to it over HTTP
with a shared API key.

```
Ariana backend  ──HTTP (X-Api-Key)──▶  this engine  ──Playwright──▶  Instagram / X / LinkedIn
     │                                      │
  her tools,                          encrypted session vault
  her memory,                         (one per account)
  her personality
```

Full setup, platform matrix and security notes: **[../SOCIAL.md](../SOCIAL.md)**.

## Deploy (Railway / Render)

1. **Railway** — new service from this repo with root directory
   `socialcrabs-service`. Point it at the included `Dockerfile`. Add a **volume
   mounted at `/data`**.
2. **Render** — new Blueprint from this repo, root directory
   `socialcrabs-service`, also Docker. Attach a **disk mounted at `/data`**.
3. Set the environment variables below.
4. **Exactly one replica.** Sessions are stateful; two replicas would fight over
   the same accounts and log each other out.
5. Copy the service URL and key into Ariana: `SOCIAL_ENGINE_URL`,
   `SOCIAL_ENGINE_API_KEY`.

### Required environment

| Variable | Why |
|---|---|
| `ENGINE_API_KEY` | Shared secret with Ariana. The engine refuses to start without it (`openssl rand -hex 24`). |
| `COOKIE_ENCRYPTION_KEY` | Encrypts sessions at rest (`openssl rand -hex 32`). Changing it invalidates every stored session. |
| `SESSION_DIR` | `/data/sessions` — must be the mounted volume, or every deploy logs the accounts out. |

Common optional ones: `MAX_BROWSERS` (default 2), `IDLE_SHUTDOWN_MINUTES` (20),
`ACTION_GAP_MS` (10000), `BROWSER_HEADLESS` (true), `LOG_LEVEL` (info). See
`.env.example` for the full list.

## Giving it a login (no passwords, ever)

Run this **on your own machine**, from this directory:

```bash
npm install
npx playwright install chromium          # once, for the --login mode

# A) sign in yourself in a real browser window
node scripts/connect-session.js --platform instagram --handle ariana.personal \
     --login --engine https://your-engine.up.railway.app --key $ENGINE_API_KEY

# B) import cookies you already have
node scripts/connect-session.js --platform linkedin --handle ariana-reyes \
     --cookies-file ~/Downloads/linkedin-cookies.json \
     --engine https://your-engine.up.railway.app --key $ENGINE_API_KEY

# C) X from two values copied out of a logged-in browser
node scripts/connect-session.js --platform twitter --handle ArianaReyes \
     --auth-token <auth_token> --ct0 <ct0> \
     --engine https://your-engine.up.railway.app --key $ENGINE_API_KEY
```

Your password is only ever typed into the platform's own page. The script sends
the resulting **session** — never a password, never anything printed to your
terminal — to the engine, which encrypts it. Then press **Connect** in Ariana's
dashboard, which verifies the login live in the browser before showing
*Connected*.

## What Ariana gets

Only what the integration can really do — the dashboard and the engine's HTTP
API both read [`src/capabilities.json`](src/capabilities.json):

| | Instagram | X | LinkedIn |
|---|:--:|:--:|:--:|
| View profile / follower counts | ✅ | ✅ | ✅ |
| Recent post list | ✅ | ❌ | ❌ |
| Search posts | ❌ | ❌ | ✅ |
| Like | ✅ | ✅ | ✅ |
| Comment / reply | ✅ | ✅ | ✅ |
| Follow / unfollow | ✅ | ✅ | ✅ |
| Send a DM | ✅ | ✅ | ✅ |
| Connection request | ❌ | ❌ | ✅ |
| Publish a post | ❌ | ✅ | ❌ |
| Repost / retweet | ❌ | ✅ | ❌ |
| Read DMs / notifications / feed | ❌ | ❌ | ❌ |
| Delete posts or comments | ❌ | ❌ | ❌ |

Every ❌ is a missing method in SocialCrabs, not a missing wire — and the engine
returns the written reason with the refusal instead of failing silently.

## API

Every route except `/health` requires `X-Api-Key: <ENGINE_API_KEY>`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, provider version, open browsers. |
| `GET` | `/api/capabilities` | The honest capability manifest. |
| `GET` | `/api/sessions` | Sessions held, plus engine status. |
| `GET` | `/api/sessions/:accountId` | One session's state (never cookie values). |
| `POST` | `/api/sessions/:accountId/verify` | Open the platform and check the login. |
| `POST` | `/api/sessions/:accountId/import` | Store a session (operator script only). |
| `DELETE` | `/api/sessions/:accountId` | Forget a session. |
| `POST` | `/api/accounts/:accountId/actions/:action` | Perform an action. |

Unsupported action → `422` with the manifest's reason. Missing session → a
refusal that names the provisioning script, not a stack trace.

## Notes on safety

- **Sessions**: AES-256-GCM at rest; a plaintext copy exists only inside the
  scratch directory while a browser is running, and is deleted when it closes.
  A session is only stored if it still contains the platform's login cookie, so
  a logged-out snapshot can never overwrite a good one.
- **One account, one browser, one rate-limit file.** No cross-account leakage.
- **Pacing** between write actions on the same account, plus SocialCrabs' own
  per-platform daily limits — two independent caps.
- **No bulk anything.** Ariana's own guards (batch ceiling, confirmations for
  unfollow/batches/publishing) sit in front of this API; the engine is the
  second line, not the only one.
- Browser errors, dead sessions and platform refusals come back as explicit
  failures with reasons. Nothing is retried in a loop.
