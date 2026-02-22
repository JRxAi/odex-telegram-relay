#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (v20+)." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is required on the target machine." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing .env file. Create it from .env.example first." >&2
  exit 1
fi

npm ci
npm run build
npm prune --omit=dev

echo "Production build completed."
echo "Run: node dist/index.js"
