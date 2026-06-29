# discord-twitch-live-screenshot

A Discord bot that captures a **source-quality, uncompressed (PNG) screenshot** of a
live Twitch stream from a channel URL — without depending on `yt-dlp` or `streamlink`.
It re-implements Twitch's anonymous GraphQL access-token negotiation directly.

## Features

- **`/twitch_screenshot channel_url:<string>`** — slash command that captures the
  best-quality frame for a channel and replies with the PNG. The reply is deferred
  because resolution + ffmpeg can take a few seconds.
- **Auto-embed** — when a message contains one or more Twitch **channel** URLs (VODs
  and clips are ignored), the bot replies (with mentions suppressed) with a
  screenshot per distinct live channel. Duplicate links to the same channel are
  captured once. Offline channels are silently ignored; a live channel whose
  retrieval fails gets a generic error reply (with full detail logged).
- **Audit logging** — auth-contract failures are posted to a configured
  `AUDIT_CHANNEL`, as is the first success after a failure (a "recovery").
- **Embed suppression** (optional, off by default) — Discord auto-unfurls a Twitch
  channel link into a near-useless profile embed. When `SUPPRESS_EMBEDS` is enabled,
  the bot hides that native embed on the user's message **after** it has posted a
  screenshot for the message. See [Embed suppression](#embed-suppression) below.

## How it works

The pipeline is: channel → signed HLS access token → usher master playlist → pick
the `chunked` (source) variant → `ffmpeg` grabs one native-resolution frame as PNG.

1. **Access token** — `POST https://gql.twitch.tv/gql` with Twitch's public web
   Client-ID and an **inline GraphQL query** (`PlaybackAccessToken_Template`).
2. **Playlist** — `GET https://usher.ttvnw.net/api/channel/hls/<channel>.m3u8` with
   the signed `token`/`sig`. A `200` returns the master playlist (the channel is
   live); a `404`/`403` with an offline marker means the channel is offline.
3. **Frame** — `ffmpeg -i <source-variant> -frames:v 1 -c:v png` → lossless PNG at
   the stream's native resolution.

### Why there is no sha256Hash to maintain

Twitch's persisted GraphQL queries are keyed by a `sha256Hash` that Twitch rotates
periodically — a hand-rolled client that hardcodes the hash breaks until it's
refreshed. **This project sends the inline query string instead of a persisted
query** (the same approach `yt-dlp` uses), so there is no rotating hash to track and
nothing to keep up to date on a schedule.

The remaining, much rarer failure mode is Twitch changing the contract itself
(retiring the anonymous Client-ID, enforcing client-integrity tokens for anonymous
requests, or altering the GraphQL schema). Those are deliberate, infrequent changes —
not something a periodic check would fix — so the bot detects them **just-in-time**:

- The resolver classifies responses into `ChannelOfflineError`, `AuthFailureError`
  (audited), or `RetrievalError`.
- An `AuthFailureError` is posted to `AUDIT_CHANNEL`; the next success posts a
  recovery notice.

If the contract ever breaks, cross-check the current approach against the vendored
references in `external_projects/`:

- `external_projects/yt-dlp/yt_dlp/extractor/twitch.py` (`_download_access_token`)
- `external_projects/streamlink/src/streamlink/plugins/twitch.py` (`TwitchAPI.access_token`)

### Embed suppression

When a user posts a Twitch channel link, Discord auto-unfurls it into a profile
embed that duplicates information and adds little next to the bot's screenshot.
Setting `SUPPRESS_EMBEDS=true` (accepts `true`/`false`/`1`/`0`, case-insensitive;
default `false`) makes the bot hide that native embed.

**What it does:** sets Discord's `SUPPRESS_EMBEDS` flag on the user's message,
which hides Discord's auto-generated link unfurls on it. This is **all-or-nothing
per message** — Discord offers no way to suppress a single embed, so if the
message contains other links, their unfurls are hidden too. Rich embeds a bot
explicitly attaches are unaffected.

**When it triggers:** only after the bot **successfully posts a screenshot** for
at least one channel linked in that message. Messages where no screenshot was
posted (offline-only, or retrieval failed) keep their native embed untouched.

**How it handles timing:** Discord attaches the auto-embed asynchronously, so it
can arrive before or after the bot's reply. The bot suppresses immediately if the
embed already exists when the screenshot is posted, otherwise it waits for the
`messageUpdate` that adds the embed and suppresses then. Per-message tracking is
evicted after 60s.

**Permission:** requires **Manage Messages** in the channel (editing another
user's message). Without it the suppress call fails with `50013` (logged) and the
rest of the bot is unaffected.

## Prerequisites

- [Bun](https://bun.com)
- **ffmpeg** on `PATH` (or set `FFMPEG_PATH`). This is a required system dependency —
  decoding H.264 HLS segments to an image is exactly what ffmpeg is for.

## Setup

```bash
bun install
cp .env.example .env   # then fill in the values
```

Required env vars (see `.env.example`): `DISCORD_TOKEN`, `DISCORD_APP_ID`,
`AUDIT_CHANNEL`. Optional: `DEV_GUILD_ID`, `LOG_LEVEL`, `FFMPEG_PATH`,
`SUPPRESS_EMBEDS` (see [Embed suppression](#embed-suppression)). Bun loads `.env`
automatically.

### Discord Developer Portal

In the [Developer Portal](https://discord.com/developers/applications):

- **Privileged intent** — under **Bot → Privileged Gateway Intents**, enable
  **Message Content Intent**. The auto-embed feature reads message text to find
  Twitch URLs and cannot work without it. (Privileged but does not require
  verification until the bot is in 100+ servers.)
- **Bot permissions** — the bot's role needs the following in any channel it
  should operate in (and in `AUDIT_CHANNEL`):
  - **View Channel** — to see the channel and receive its message events
  - **Read Message History** — required by `message.reply()`, which references the
    original message
  - **Send Messages** — to reply
  - **Attach Files** — to upload the screenshot (without this you'll get
    `DiscordAPIError: Missing Permissions`, code `50013`)
  - **Manage Messages** — *optional*, only needed when `SUPPRESS_EMBEDS` is
    enabled. Required to edit another user's message to hide its auto-embed.
    Without it, suppression silently no-ops (logged as code `50013`) and
    everything else still works.

  When generating an invite under **OAuth2 → URL Generator**, select the `bot`
  and `applications.commands` scopes plus the permissions above.

## Running

```bash
bun run deploy-commands   # register the slash command (once, or after changes)
bun run start             # start the bot
bun run dev               # start with --watch
```

## Docker

The image embeds a statically-linked `ffmpeg` build (from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)), so the container
needs no system ffmpeg and works out of the box. It is downloaded in an isolated
build stage and copied to `/home/bun/.local/bin/ffmpeg`, which is on the
runtime user's `PATH` — so the app's default `ffmpegPath` of `"ffmpeg"` resolves
it with no `FFMPEG_PATH` override. Builds are multi-arch (`amd64` / `arm64`).

```bash
cp .env.example .env      # then fill in the values
bun run local:prod:up     # docker compose up --build -d
bun run local:prod:down   # docker compose down
```

The container runs the bot (`bun run start`). Slash-command registration
(`deploy-commands`) is a one-time host task — run it once against your
application before starting the container.

## Development

```bash
bun run typecheck
bun run codecheck:fix
bun run test
```

## Architecture

Hexagonal / DDD layering (`src/`):

- `domain/` — `TwitchChannel` (URL parsing/validation), HLS playlist parsing,
  error hierarchy, and port interfaces (`StreamResolver`, `FrameGrabber`,
  `AuditLogger`, `Logger`). No outward dependencies.
- `application/` — `ScreenshotService` orchestrates resolve → grab and tracks
  auth-contract health (broken ↔ recovered).
- `infrastructure/` — adapters: `TwitchGqlResolver` (fetch), `FfmpegFrameGrabber`
  (system ffmpeg), `DiscordBot` / `DiscordAuditLogger` (discord.js), pino logger,
  env config.
