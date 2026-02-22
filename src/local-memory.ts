import fs from "node:fs/promises";
import path from "node:path";
import { relayConfig } from "./config.js";

type RememberScope = "global" | "chat";

type ForgetResult = {
  globalRemoved: number;
  chatRemoved: number;
};

const MAX_STORED_LINES = 800;

function existsEnabled(): boolean {
  return relayConfig.localMemoryEnabled;
}

function chatMemoryPath(chatId: number): string {
  return path.join(relayConfig.chatMemoryDir, `${chatId}.md`);
}

function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function writeLines(filePath: string, lines: string[]): Promise<void> {
  await ensureParentDir(filePath);
  const limited = lines.slice(-MAX_STORED_LINES);
  const payload = limited.join("\n");
  await fs.writeFile(filePath, payload ? payload + "\n" : "", "utf8");
}

async function appendUniqueLine(filePath: string, rawLine: string): Promise<boolean> {
  const line = normalizeLine(rawLine);
  if (!line) {
    return false;
  }

  const existing = await readFileSafe(filePath);
  const lines = splitLines(existing);
  const lower = line.toLowerCase();
  if (lines.some((item) => item.toLowerCase() === lower)) {
    return false;
  }

  lines.push(line);
  await writeLines(filePath, lines);
  return true;
}

function removeMatchingLines(lines: string[], query: string): { lines: string[]; removed: number } {
  const needle = normalizeLine(query).toLowerCase();
  if (!needle) {
    return { lines, removed: 0 };
  }

  const next: string[] = [];
  let removed = 0;

  for (const line of lines) {
    if (line.toLowerCase().includes(needle)) {
      removed += 1;
      continue;
    }
    next.push(line);
  }

  return { lines: next, removed };
}

function section(label: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `${label}:\n${trimmed}` : "";
}

function safePreview(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(empty)";
  }
  return trimToMaxChars(trimmed, maxChars);
}

export function isLocalMemoryEnabled(): boolean {
  return existsEnabled();
}

export function getLocalMemoryPaths(chatId: number): { soulFile: string; memoryFile: string; chatFile: string } {
  return {
    soulFile: relayConfig.soulFile,
    memoryFile: relayConfig.memoryFile,
    chatFile: chatMemoryPath(chatId)
  };
}

export async function buildLocalPromptContext(chatId: number): Promise<string> {
  if (!existsEnabled()) {
    return "";
  }

  const [soulRaw, memoryRaw, chatRaw] = await Promise.all([
    readFileSafe(relayConfig.soulFile),
    readFileSafe(relayConfig.memoryFile),
    readFileSafe(chatMemoryPath(chatId))
  ]);

  const parts = [
    section("SOUL PROFILE", soulRaw),
    section("GLOBAL MEMORY", memoryRaw),
    section("CHAT MEMORY", chatRaw)
  ].filter((item) => item.length > 0);

  if (parts.length === 0) {
    return "";
  }

  return trimToMaxChars(parts.join("\n\n"), relayConfig.localMemoryContextMaxChars);
}

export async function rememberNote(chatId: number, note: string, scope: RememberScope): Promise<boolean> {
  if (!existsEnabled()) {
    return false;
  }

  const filePath = scope === "chat" ? chatMemoryPath(chatId) : relayConfig.memoryFile;
  return appendUniqueLine(filePath, note);
}

export async function forgetNotes(chatId: number, query: string): Promise<ForgetResult> {
  if (!existsEnabled()) {
    return { globalRemoved: 0, chatRemoved: 0 };
  }

  const globalPath = relayConfig.memoryFile;
  const chatPath = chatMemoryPath(chatId);

  const [globalRaw, chatRaw] = await Promise.all([readFileSafe(globalPath), readFileSafe(chatPath)]);
  const globalResult = removeMatchingLines(splitLines(globalRaw), query);
  const chatResult = removeMatchingLines(splitLines(chatRaw), query);

  if (globalResult.removed > 0) {
    await writeLines(globalPath, globalResult.lines);
  }
  if (chatResult.removed > 0) {
    await writeLines(chatPath, chatResult.lines);
  }

  return { globalRemoved: globalResult.removed, chatRemoved: chatResult.removed };
}

export async function getMemoryDebugPreview(chatId: number): Promise<string> {
  if (!existsEnabled()) {
    return "Local memory is disabled (`LOCAL_MEMORY_ENABLED=false`).";
  }

  const paths = getLocalMemoryPaths(chatId);
  const [soulRaw, memoryRaw, chatRaw] = await Promise.all([
    readFileSafe(paths.soulFile),
    readFileSafe(paths.memoryFile),
    readFileSafe(paths.chatFile)
  ]);

  return [
    "Local memory files:",
    `- soul: ${paths.soulFile}`,
    `- memory: ${paths.memoryFile}`,
    `- chat: ${paths.chatFile}`,
    "",
    "Soul preview:",
    safePreview(soulRaw, relayConfig.localMemoryPreviewChars),
    "",
    "Memory preview:",
    safePreview(memoryRaw, relayConfig.localMemoryPreviewChars),
    "",
    "Chat preview:",
    safePreview(chatRaw, relayConfig.localMemoryPreviewChars)
  ].join("\n");
}

export async function getSoulPreview(): Promise<string> {
  if (!existsEnabled()) {
    return "Local soul profile is disabled (`LOCAL_MEMORY_ENABLED=false`).";
  }

  const soulRaw = await readFileSafe(relayConfig.soulFile);
  return [
    `Soul file: ${relayConfig.soulFile}`,
    "",
    safePreview(soulRaw, relayConfig.localMemoryPreviewChars)
  ].join("\n");
}

export async function processLocalMemoryIntents(chatId: number, response: string): Promise<string> {
  if (!existsEnabled() || !response.trim()) {
    return response;
  }

  let clean = response;

  for (const match of response.matchAll(/\[MEMORY_ADD:\s*(.+?)\]/gi)) {
    const note = match[1]?.trim();
    if (note) {
      await rememberNote(chatId, note, "global");
    }
    clean = clean.replace(match[0], "");
  }

  for (const match of response.matchAll(/\[CHAT_MEMORY_ADD:\s*(.+?)\]/gi)) {
    const note = match[1]?.trim();
    if (note) {
      await rememberNote(chatId, note, "chat");
    }
    clean = clean.replace(match[0], "");
  }

  for (const match of response.matchAll(/\[MEMORY_FORGET:\s*(.+?)\]/gi)) {
    const query = match[1]?.trim();
    if (query) {
      await forgetNotes(chatId, query);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.replace(/\n{3,}/g, "\n\n").trim();
}
