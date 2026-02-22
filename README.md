# Odex Telegram Relay

Telegram bot that relays messages to **Codex CLI** (`codex exec`) instead of Claude Code.

## What it does

- Relays Telegram text messages to Codex.
- Keeps per-chat Codex sessions via `codex exec resume`.
- Supports image attachments (`--image` passed to Codex).
- Supports voice/audio by transcribing first (optional, via Groq API).
- Includes chat allowlist support.

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
npm run dev
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
- `GROQ_API_KEY` + `TRANSCRIPTION_MODEL` (for voice/audio)
- `GROQ_BASE_URL` (override Groq-compatible endpoint if needed)

## Commands

- `/start` show status and commands
- `/new` or `/reset` reset current Codex session in this chat
- `/session` show current session id

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

## Notes

- This bot executes Codex in non-interactive mode (`codex exec`).
- Codex process permissions are controlled by `CODEX_SANDBOX`.
- If Codex CLI cannot reach network/API at runtime, relay calls fail with surfaced errors.
