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

type MessagePayload = {
  prompt: string;
  imagePaths: string[];
  cleanupTargets: string[];
};

const sessions = new SessionStore(relayConfig.sessionsFile);
const openai = relayConfig.openAiApiKey
  ? new OpenAI({ apiKey: relayConfig.openAiApiKey })
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
  const extension = path.extname(file.file_path) || `.${fallbackExtension}`;
  const localPath = path.join(tempDir, `payload${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.writeFile(localPath, buffer);
  return localPath;
}

async function transcribeAudio(localPath: string): Promise<string> {
  if (!openai) {
    throw new Error("Voice input requires OPENAI_API_KEY.");
  }

  const result = await openai.audio.transcriptions.create({
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
  const promptParts: string[] = [];

  const text = typeof msg.text === "string" ? msg.text : typeof msg.caption === "string" ? msg.caption : "";
  if (text.trim()) {
    promptParts.push(text.trim());
  }

  const photos = Array.isArray(msg.photo) ? (msg.photo as Array<{ file_id: string }>) : [];
  if (photos.length > 0) {
    const bestPhoto = photos[photos.length - 1];
    const localPath = await downloadTelegramFile(bot, bestPhoto.file_id, "jpg");
    imagePaths.push(localPath);
    cleanupTargets.push(path.dirname(localPath));

    if (!text.trim()) {
      promptParts.push("Analyze the attached image.");
    }
  }

  const document = msg.document as { file_id?: string; mime_type?: string } | undefined;
  if (document?.file_id && document.mime_type?.startsWith("image/")) {
    const localPath = await downloadTelegramFile(bot, document.file_id, "jpg");
    imagePaths.push(localPath);
    cleanupTargets.push(path.dirname(localPath));

    if (!text.trim()) {
      promptParts.push("Analyze the attached image document.");
    }
  }

  const voice = msg.voice as { file_id?: string } | undefined;
  if (voice?.file_id) {
    const localPath = await downloadTelegramFile(bot, voice.file_id, "ogg");
    cleanupTargets.push(path.dirname(localPath));
    const transcription = await transcribeAudio(localPath);
    promptParts.push(`Voice transcript:\n${transcription}`);
  }

  const audio = msg.audio as { file_id?: string } | undefined;
  if (audio?.file_id) {
    const localPath = await downloadTelegramFile(bot, audio.file_id, "mp3");
    cleanupTargets.push(path.dirname(localPath));
    const transcription = await transcribeAudio(localPath);
    promptParts.push(`Audio transcript:\n${transcription}`);
  }

  if (relayConfig.systemPrompt) {
    promptParts.unshift(`System instructions:\n${relayConfig.systemPrompt}`);
  }

  const prompt = promptParts.join("\n\n").trim();
  if (!prompt) {
    throw new Error("Send text, image, or voice message.");
  }

  return { prompt, imagePaths, cleanupTargets };
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

function unauthorizedMessage(ctx: Context): Promise<void> {
  return ctx.reply("This bot is restricted. Add your chat ID to ALLOWED_CHAT_IDS.");
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

        const priorSessionId = await sessions.get(chatId);
        const result = await runCodexTurn({
          prompt: payload.prompt,
          sessionId: priorSessionId,
          imagePaths: payload.imagePaths
        });

        if (result.sessionId) {
          await sessions.set(chatId, result.sessionId);
        }

        await sendResponse(ctx, result.reply);
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
