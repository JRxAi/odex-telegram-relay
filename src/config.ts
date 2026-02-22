import path from "node:path";
import { config as loadDotEnv } from "dotenv";

loadDotEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseChatIdSet(raw: string | undefined): Set<number> {
  if (!raw?.trim()) {
    return new Set();
  }

  const result = new Set<number>();
  for (const token of raw.split(",")) {
    const value = Number(token.trim());
    if (Number.isFinite(value)) {
      result.add(value);
    }
  }

  return result;
}

function parseSandbox(raw: string | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  if (raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access") {
    return raw;
  }
  return "workspace-write";
}

function parseMaxReplyChars(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 200 || parsed > 4096) {
    return 3800;
  }
  return Math.floor(parsed);
}

export type RelayConfig = {
  telegramBotToken: string;
  allowedChatIds: Set<number>;
  codexBin: string;
  codexModel?: string;
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexCwd: string;
  sessionsFile: string;
  systemPrompt?: string;
  maxReplyChars: number;
  groqApiKey?: string;
  groqBaseUrl: string;
  transcriptionModel: string;
};

export const relayConfig: RelayConfig = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  allowedChatIds: parseChatIdSet(process.env.ALLOWED_CHAT_IDS),
  codexBin: optional("CODEX_BIN") ?? "codex",
  codexModel: optional("CODEX_MODEL"),
  codexSandbox: parseSandbox(optional("CODEX_SANDBOX")),
  codexCwd: path.resolve(optional("CODEX_CWD") ?? process.cwd()),
  sessionsFile: path.resolve(optional("SESSIONS_FILE") ?? ".data/sessions.json"),
  systemPrompt: optional("SYSTEM_PROMPT"),
  maxReplyChars: parseMaxReplyChars(optional("MAX_REPLY_CHARS")),
  groqApiKey: optional("GROQ_API_KEY") ?? optional("OPENAI_API_KEY"),
  groqBaseUrl: optional("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
  transcriptionModel: optional("TRANSCRIPTION_MODEL") ?? "whisper-large-v3-turbo"
};
