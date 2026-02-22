# Codex Telegram Relay

Telegram bot that relays messages to **Codex CLI** (`codex exec`) instead of Claude Code.

## What it does

- Relays Telegram text messages to Codex.
- Keeps per-chat Codex sessions via `codex exec resume`.
- Supports image attachments (`--image` passed to Codex).
- Supports voice/audio by transcribing first (optional, via OpenAI API).
- Includes chat allowlist support.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated (`codex login`)
- Telegram bot token from @BotFather
- Optional for voice/audio: OpenAI API key

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

Optional:

- `CODEX_MODEL`
- `SYSTEM_PROMPT`
- `OPENAI_API_KEY` + `TRANSCRIPTION_MODEL` (for voice/audio)

## Commands

- `/start` show status and commands
- `/new` or `/reset` reset current Codex session in this chat
- `/session` show current session id

## Build for production

```bash
npm run build
npm run start
```

## Create a completely new GitHub repo

Run inside this folder:

```bash
git init
git add .
git commit -m "Initial Codex Telegram relay"
git branch -M main
```

If you use GitHub CLI:

```bash
gh repo create codex-telegram-relay --public --source=. --remote=origin --push
```

Or create an empty repo on GitHub web and then:

```bash
git remote add origin git@github.com:<your-user>/codex-telegram-relay.git
git push -u origin main
```

## Notes

- This bot executes Codex in non-interactive mode (`codex exec`).
- Codex process permissions are controlled by `CODEX_SANDBOX`.
- If Codex CLI cannot reach network/API at runtime, relay calls will fail with a surfaced error.
