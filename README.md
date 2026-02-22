# Odex Telegram Relay

Telegram bot that relays messages to **Codex CLI** (`codex exec`) instead of Claude Code.

## What it does

- Relays Telegram text messages to Codex.
- Keeps per-chat Codex sessions via `codex exec resume`.
- Supports image attachments (`--image` passed to Codex).
- Supports voice/audio by transcribing first (optional, via Groq API).
- Supports optional long-term memory via Supabase (`messages` + `memory` tables).
- Supports optional local file memory via `soul.md`, `memory.md`, and per-chat notes.
- Includes chat allowlist support.

## How it works

1. User sends a Telegram message (text, image, voice, audio).
2. Relay normalizes payload:
   - text/caption is used directly
   - image is downloaded and passed via `--image`
   - voice/audio is transcribed via Groq (if enabled)
3. Relay optionally loads long-term context from Supabase and local memory files.
4. Relay executes `codex exec` (or `codex exec resume` when session exists).
5. Relay sends assistant response back to Telegram (chunked to max length).
6. Session ID is stored per chat in `SESSIONS_FILE`.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated (`codex login`)
- Telegram bot token from @BotFather
- Optional for voice/audio: Groq API key

## Quick start

```bash
./scripts/setup.sh
cp .env.example .env
# edit .env
npm run build
npm run start
```

Dashboard (optional, local):

```bash
npm run dashboard
# open http://localhost:4243
```

## Environment

See `.env.example` for all options.

Required:

- `TELEGRAM_BOT_TOKEN`

Strongly recommended:

- `ALLOWED_CHAT_IDS` (restrict bot usage)
- `CODEX_CWD` (folder Codex should work in)
- `CODEX_BIN` (absolute path in production, for example `/usr/local/bin/codex`)

Optional:

- `CODEX_MODEL`
- `SYSTEM_PROMPT`
- `DASHBOARD_HOST`, `DASHBOARD_PORT` (defaults: `127.0.0.1:4243`)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (long-term memory)
- `SUPABASE_RECENT_MESSAGES`, `SUPABASE_CONTEXT_MAX_CHARS` (context budget)
- `SUPABASE_ENABLE_SEMANTIC_SEARCH`, `SUPABASE_SEMANTIC_MATCHES` (Edge Function search)
- `LOCAL_MEMORY_ENABLED`, `SOUL_FILE`, `MEMORY_FILE`, `CHAT_MEMORY_DIR`
- `LOCAL_MEMORY_CONTEXT_MAX_CHARS`, `LOCAL_MEMORY_PREVIEW_CHARS`
- `GROQ_API_KEY` + `TRANSCRIPTION_MODEL` (for voice/audio)
- `GROQ_BASE_URL` (override Groq-compatible endpoint if needed)
- `MAX_REPLY_CHARS` (200..4096, default 3800)

## Commands

- `/start` show status and commands
- `/new` or `/reset` reset current Codex session in this chat
- `/session` show current session id
- `/memory` show soul/memory previews + file paths
- `/soul` show soul profile preview
- `/remember <text>` store global note to `memory.md`
- `/remember chat: <text>` store chat-specific note
- `/forget <text>` delete matching notes

## Dashboard

- Route: `http://localhost:4243`
- API: `GET /api/state`
- Shows:
  - active chat -> session map
  - relay/sandbox configuration snapshot
  - local memory previews (`soul.md`, `memory.md`, chat files)
  - relay log tail (`.data/relay.log`)

Start dashboard:

```bash
npm run dashboard
```

## Limits and behavior

- Telegram replies are chunked by `MAX_REPLY_CHARS` (default `3800`).
- One request per chat is processed at a time (in-chat queue).
- Voice/audio transcription requires `GROQ_API_KEY`; otherwise voice/audio requests fail with a clear error.
- Supported media inputs: `photo`, `image/*` document, `voice`, `audio`.
- Session state is persisted to `SESSIONS_FILE` (default `.data/sessions.json`).
- Supabase memory is optional; when not configured, relay still works with local session resume.
- Local file memory is optional; when enabled, relay injects `soul.md` and `memory.md` context into prompts.

## Supabase setup (optional)

1. In Supabase SQL editor, run:
   - `deploy/supabase/schema.sql`
2. In `.env`, set:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY` if your RLS policies allow it)
3. Restart the relay.

Note:

- Semantic memory search uses a Supabase Edge Function named `search`.
- If `search` is not deployed, relay silently falls back to recent chat history + facts/goals.

## Local file memory setup (optional)

1. Edit:
   - `soul.md` (assistant identity and behavior)
   - `memory.md` (durable global notes)
2. Use commands for runtime updates:
   - `/remember`, `/forget`, `/memory`, `/soul`
3. For per-chat notes, relay stores files in `CHAT_MEMORY_DIR` (default `.data/chat-memory`).

Optional reply tags (auto-processed):

- `[MEMORY_ADD: text]`
- `[CHAT_MEMORY_ADD: text]`
- `[MEMORY_FORGET: text]`

## Build for production

```bash
npm run build:prod
npm run start
```

## 24/7 deploy with PM2

```bash
npm run build:prod
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs odex-telegram-relay
pm2 restart odex-telegram-relay
```

## 24/7 deploy with systemd (Linux)

1. Copy project to `/opt/odex-telegram-relay`.
2. Create `/opt/odex-telegram-relay/.env`.
3. Run `npm run build:prod` in that folder.
4. Ensure Codex is logged in for the service user (`sudo -u odex codex login`).
5. Copy `deploy/systemd/odex-telegram-relay.service` to `/etc/systemd/system/` and adjust user/paths if needed.
6. Start service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now odex-telegram-relay
sudo systemctl status odex-telegram-relay
```

Logs:

```bash
journalctl -u odex-telegram-relay -f
```

## Troubleshooting

- `Error: For more information, try '--help'.`
  - Update to latest code and rebuild. This usually means a CLI flag mismatch in older relay builds.
- `Network request for 'getMe' failed` or `ENOTFOUND api.telegram.org`
  - Runtime host cannot resolve/reach Telegram API.
- `Failed to execute Codex CLI`
  - Set `CODEX_BIN` to absolute path of `codex` binary.
- Voice message fails with missing key
  - Set `GROQ_API_KEY` in `.env`.
- Supabase warnings in logs
  - Run `deploy/supabase/schema.sql` and verify `SUPABASE_URL` / key values.

## Security notes

- Always set `ALLOWED_CHAT_IDS` so random users cannot call your bot.
- Run with least privilege sandbox (`CODEX_SANDBOX=workspace-write` by default).
- Rotate leaked Telegram/Groq tokens immediately.
