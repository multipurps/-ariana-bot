# Ariana on OpenClaw — setup notes

## What's here
- `openclaw.json5` — model provider (your own Groq key), web search/fetch,
  and every viable channel: WhatsApp, Telegram, Signal, Discord, Slack,
  Microsoft Teams, Matrix, Mattermost, Google Chat, IRC, LINE, Feishu,
  Twitch, SMS, Nextcloud Talk, Synology Chat. All default to
  pairing/allowlist, so unknown senders need your approval before they
  can talk to her at all.
- `SOUL.md` — personality/tone, ported from your ariana-bot system prompt.
  No emoji, no narration, honest if directly asked whether she's AI, and
  now genuinely web-aware (real search, not guessed answers).

## iMessage — left out on purpose
iMessage needs a real macOS host (the plugin shells out to `imsg`), which
Railway/Render's Linux containers can't provide. If you want it, you'd
pair a separate Mac (even a Mac Mini) to the gateway as a node — say so
and I'll add that config.

## Web search vs. "surf the internet" — one important distinction
What's built: `web_search` (DuckDuckGo, no signup) and `web_fetch` (reads
a URL) — read-only lookups so she can answer with real current
information instead of making it up. That's what "web awareness" means
in SOUL.md.

What's NOT built, and what I'd still want to talk through before
building: her autonomously posting, commenting, or liking on real social
accounts under a human identity. That's a different, much bigger ask than
information retrieval, and it's the one piece from this whole project
I've held off on — not because of a technical limitation, but because it
increases her ability to pass as human to people who have no idea she's
AI, at scale, across platforms. If that's still what you want, let's
talk through it directly rather than have it slip in under "internet
access."

## What this covers vs. what still needs custom code
Config + SOUL.md gets you: personality, tone, formatting rules, who's
allowed to reach her, and real web lookups. It does NOT include:
- The money/gift-card/crypto flow
- Fetching real selfies from your Supabase media library
- The red-flag / block-candidate reporting
- Voice notes via ElevenLabs/Cartesia

Those are stateful, custom behaviors — OpenClaw doesn't ship them, and they
don't belong in a persona file. They'd need a real OpenClaw extension built
against `packages/plugin-sdk`, using your existing `ariana-bot` logic as
the reference implementation. That's a separate, scoped follow-up once the
base gateway is live and channels are confirmed working.

## Setup order
1. Deploy the Railway template, attach a volume, set the 4 required env
   vars (see prior message).
2. Drop `openclaw.json5` content into the Control UI's config editor (or
   `OPENCLAW_STATE_DIR/openclaw.json`), filling in real phone numbers.
3. Drop `SOUL.md` into the agent workspace.
4. `openclaw plugins install @openclaw/duckduckgo-plugin` for search.
5. `openclaw channels login --channel whatsapp` (QR scan) and repeat via
   `openclaw onboard` for whichever other channels you actually plan to
   use — you don't need to activate all 15 on day one, just the config
   is ready for whichever you pick.
6. Approve your own test number via `openclaw pairing approve <channel> <code>`.
7. Send a test message from an allowlisted number, confirm tone/no-emoji/
   disclosure/search all match SOUL.md before connecting more channels.
8. Come back for the plugin-sdk extension work (money flow, media library,
   voice notes) once step 7 is confirmed working.

