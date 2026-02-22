import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "grammy";
import { Bot } from "grammy";
import OpenAI from "openai";
import { relayConfig } from "./config.js";
import { runCodexTurn } from "./codex-runner.js";
import { SessionStore } from "./session-store.js";
import {
  buildSupabasePromptContext,
  isSupabaseEnabled,
  processMemoryIntents,
  saveChatMessage
} from "./supabase-memory.js";

type MessagePayload = {
  prompt: string;
  userContent: string;
  imagePaths: string[];
  cleanupTargets: string[];
};

const sessions = new SessionStore(relayConfig.sessionsFile);
const groq = relayConfig.groqApiKey
  ? new OpenAI({ apiKey: relayConfig.groqApiKey, baseURL: relayConfig.groqBaseUrl })
  : undefined;

const inFlightByChat = new Map<number, Promise<void>>();

function isAuthorized(ctx: Context): boolean {
  if (relayConfig.allowedChatIds.size === 0) {
    return true;
  }

  const chatId = ctx.chat?.id;
  return typeof chatId === "number" && relayConfig.allowedChatIds.has(chatId);
}

function enqueueByChat(chatId: number, task: () => Promise<void>): void {
  const previous = inFlightByChat.get(chatId) ?? Promise.resolve();
  const next = previous
    .then(task, task)
    .catch((error) => {
      console.error("Queue task failed", error);
    })
    .finally(() => {
      if (inFlightByChat.get(chatId) === next) {
        inFlightByChat.delete(chatId);
      }
    });

  inFlightByChat.set(chatId, next);
}

function splitForTelegram(text: string, max = relayConfig.maxReplyChars): string[] {
  if (text.length <= max) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.6) {
      cut = max;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendResponse(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await ctx.reply(chunk);
  }
}

function appendLongTermContext(prompt: string, context: string): string {
  const trimmedContext = context.trim();
  if (!trimmedContext) {
    return prompt;
  }

  return [
    prompt.trim(),
    "Long-term memory context from previous chats (optional reference):",
    trimmedContext
  ].join("\n\n");
}

function asksForCapabilityOrPolicy(userContent: string): boolean {
  return /(?:\bwhat can you do\b|capabilities|permissions|sandbox|approval policy|read-?only|memory model|ako funguje .*pam[aä]ť|[čc]o .*vie[šs] robi[ťt]|[čc]o .*m[oô][žz]e[šs])/i.test(
    userContent
  );
}

function looksLikeMetaCapabilityReply(text: string): boolean {
  return /(?:\bread-?only\b|approval policy|v tejto rel[aá]cii|po[cč]as tejto konverz[aá]cie|nem[oô][žz]em .*zapis|nem[oô][žz]em .*uprav|i can(?:not|'t)? .*write|i can only read|ako funguje moja pam[aä]ť)/i.test(
    text
  );
}

function normalizeTelegramExtension(filePath: string, fallbackExtension: string): string {
  const raw = path.extname(filePath).toLowerCase();
  if (!raw) {
    return `.${fallbackExtension}`;
  }

  // Telegram voice notes frequently use .oga, but Groq expects .ogg.
  if (raw === ".oga") {
    return ".ogg";
  }

  return raw;
}

async function downloadTelegramFile(bot: Bot, fileId: string, fallbackExtension: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not provide a file path.");
  }

  const fileUrl = `https://api.telegram.org/file/bot${relayConfig.telegramBotToken}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file (${response.status}).`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tg-file-"));
  const extension = normalizeTelegramExtension(file.file_path, fallbackExtension);
  const localPath = path.join(tempDir, `payload${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.writeFile(localPath, buffer);
  return localPath;
}

async function transcribeAudio(localPath: string): Promise<string> {
  if (!groq) {
    throw new Error("Voice input requires GROQ_API_KEY.");
  }

  const result = await groq.audio.transcriptions.create({
    model: relayConfig.transcriptionModel,
    file: createReadStream(localPath)
  });

  const text = result.text?.trim();
  if (!text) {
    throw new Error("Audio transcription returned empty text.");
  }

  return text;
}

async function buildPayload(bot: Bot, ctx: Context): Promise<MessagePayload> {
  const msg = ctx.message as Record<string, unknown> | undefined;
  if (!msg) {
    throw new Error("Unsupported update type.");
  }

  const cleanupTargets: string[] = [];
  const imagePaths: string[] = [];
  const userPromptParts: string[] = [];

  const text = typeof msg.text === "string" ? msg.text : typeof msg.caption === "string" ? msg.caption : "";
  if (text.trim()) {
    userPromptParts.push(text.trim());
  }

  const photos = Array.isArray(msg.photo) ? (msg.photo as Array<{ file_id: string }>) : [];
  if (photos.length > 0) {
    const bestPhoto = photos[photos.length - 1];
    const localPath = await downloadTelegramFile(bot, bestPhoto.file_id, "jpg");
    imagePaths.push(localPath);
    cleanupTargets.push(path.dirname(localPath));

    if (!text.trim()) {
      userPromptParts.push("Analyze the attached image.");
    }
  }

  const document = msg.document as { file_id?: string; mime_type?: string } | undefined;
  if (document?.file_id && document.mime_type?.startsWith("image/")) {
    const localPath = await downloadTelegramFile(bot, document.file_id, "jpg");
    imagePaths.push(localPath);
    cleanupTargets.push(path.dirname(localPath));

    if (!text.trim()) {
      userPromptParts.push("Analyze the attached image document.");
    }
  }

  const voice = msg.voice as { file_id?: string } | undefined;
  if (voice?.file_id) {
    const localPath = await downloadTelegramFile(bot, voice.file_id, "ogg");
    cleanupTargets.push(path.dirname(localPath));
    const transcription = await transcribeAudio(localPath);
    userPromptParts.push(`Voice transcript:\n${transcription}`);
  }

  const audio = msg.audio as { file_id?: string } | undefined;
  if (audio?.file_id) {
    const localPath = await downloadTelegramFile(bot, audio.file_id, "mp3");
    cleanupTargets.push(path.dirname(localPath));
    const transcription = await transcribeAudio(localPath);
    userPromptParts.push(`Audio transcript:\n${transcription}`);
  }

  const userContent = userPromptParts.join("\n\n").trim();
  if (!userContent) {
    throw new Error("Send text, image, or voice message.");
  }

  const promptParts = relayConfig.systemPrompt
    ? [`System instructions:\n${relayConfig.systemPrompt}`, userContent]
    : [userContent];
  const prompt = promptParts.join("\n\n").trim();
  if (!prompt) {
    throw new Error("Prompt assembly failed.");
  }

  return { prompt, userContent, imagePaths, cleanupTargets };
}

async function runFocusedRetry(
  payload: MessagePayload,
  sessionId: string | undefined
): Promise<{ reply: string; sessionId?: string }> {
  const retryPrompt = [
    "Rewrite your previous response.",
    "Strict rules:",
    "- Do NOT discuss your capabilities, sandbox, approval policy, or memory model.",
    "- Answer only the user's request directly.",
    "- Keep it practical and concise.",
    "- Reply in Slovak unless explicitly asked otherwise.",
    "",
    `User request:\n${payload.userContent}`
  ].join("\n");

  return runCodexTurn({
    prompt: retryPrompt,
    sessionId,
    imagePaths: payload.imagePaths
  });
}

async function cleanupTargets(pathsToRemove: string[]): Promise<void> {
  await Promise.all(
    pathsToRemove.map(async (target) => {
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch {
        // Best effort cleanup.
      }
    })
  );
}

function humanError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Unknown error while handling your request.";
}

async function unauthorizedMessage(ctx: Context): Promise<void> {
  await ctx.reply("This bot is restricted. Add your chat ID to ALLOWED_CHAT_IDS.");
}

export function createRelayBot(): Bot {
  const bot = new Bot(relayConfig.telegramBotToken);

  bot.command("start", async (ctx) => {
    if (!isAuthorized(ctx)) {
      await unauthorizedMessage(ctx);
      return;
    }

    await ctx.reply(
      [
        "Codex Telegram Relay is running.",
        `Memory backend: ${isSupabaseEnabled() ? "Supabase" : "local sessions only"}`,
        "",
        "Commands:",
        "/new - reset Codex conversation for this chat",
        "/session - show current Codex session id"
      ].join("\n")
    );
  });

  bot.command(["new", "reset"], async (ctx) => {
    if (!isAuthorized(ctx)) {
      await unauthorizedMessage(ctx);
      return;
    }

    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      return;
    }

    await sessions.clear(chatId);
    await ctx.reply("Session reset. Next message starts a fresh Codex conversation.");
  });

  bot.command("session", async (ctx) => {
    if (!isAuthorized(ctx)) {
      await unauthorizedMessage(ctx);
      return;
    }

    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      return;
    }

    const sessionId = await sessions.get(chatId);
    await ctx.reply(sessionId ? `Current session: ${sessionId}` : "No active session yet.");
  });

  bot.on("message", async (ctx) => {
    if (!isAuthorized(ctx)) {
      await unauthorizedMessage(ctx);
      return;
    }

    const rawText = "text" in ctx.message ? ctx.message.text : undefined;
    if (typeof rawText === "string" && rawText.startsWith("/")) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      return;
    }

    enqueueByChat(chatId, async () => {
      const typingTick = setInterval(() => {
        void ctx.api.sendChatAction(chatId, "typing");
      }, 4000);

      void ctx.api.sendChatAction(chatId, "typing");

      let cleanup: string[] = [];
      try {
        const payload = await buildPayload(bot, ctx);
        cleanup = payload.cleanupTargets;

        await saveChatMessage({
          chatId,
          role: "user",
          content: payload.userContent,
          metadata: {
            has_images: payload.imagePaths.length > 0
          }
        });

        const priorSessionId = await sessions.get(chatId);
        const memoryContext = await buildSupabasePromptContext(chatId, payload.userContent);
        const result = await runCodexTurn({
          prompt: appendLongTermContext(payload.prompt, memoryContext),
          sessionId: priorSessionId,
          imagePaths: payload.imagePaths
        });

        let activeSessionId = result.sessionId ?? priorSessionId;
        if (activeSessionId) {
          await sessions.set(chatId, activeSessionId);
        }

        let processedReply = await processMemoryIntents(result.reply);
        let outgoingReply = processedReply || result.reply || "Codex completed but returned an empty message.";

        if (looksLikeMetaCapabilityReply(outgoingReply) && !asksForCapabilityOrPolicy(payload.userContent)) {
          const retry = await runFocusedRetry(payload, activeSessionId);
          activeSessionId = retry.sessionId ?? activeSessionId;
          if (activeSessionId) {
            await sessions.set(chatId, activeSessionId);
          }

          processedReply = await processMemoryIntents(retry.reply);
          const retriedReply = processedReply || retry.reply;
          if (retriedReply.trim()) {
            outgoingReply = retriedReply;
          }
        }

        await saveChatMessage({
          chatId,
          role: "assistant",
          content: outgoingReply,
          metadata: {
            session_id: activeSessionId ?? null
          }
        });

        await sendResponse(ctx, outgoingReply);
      } catch (error) {
        await ctx.reply(`Error: ${humanError(error)}`);
      } finally {
        clearInterval(typingTick);
        await cleanupTargets(cleanup);
      }
    });
  });

  bot.catch((error) => {
    console.error("Telegram bot error", error.error);
  });

  return bot;
}
