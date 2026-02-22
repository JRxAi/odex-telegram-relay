import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { relayConfig } from "./config.js";

export type CodexTurnInput = {
  prompt: string;
  sessionId?: string;
  imagePaths?: string[];
};

export type CodexTurnResult = {
  reply: string;
  sessionId?: string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
};

function buildArgs(input: CodexTurnInput, outputFile: string): string[] {
  const baseArgs: string[] = input.sessionId ? ["exec", "resume"] : ["exec"];

  baseArgs.push("--skip-git-repo-check");
  baseArgs.push("--sandbox", relayConfig.codexSandbox);
  baseArgs.push("--json");
  baseArgs.push("--color", "never");
  baseArgs.push("--output-last-message", outputFile);

  if (relayConfig.codexModel) {
    baseArgs.push("--model", relayConfig.codexModel);
  }

  for (const imagePath of input.imagePaths ?? []) {
    baseArgs.push("--image", imagePath);
  }

  if (input.sessionId) {
    baseArgs.push(input.sessionId);
  }

  baseArgs.push(input.prompt);

  return baseArgs;
}

export async function runCodexTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-"));
  const outputFile = path.join(tempDir, "assistant-message.txt");

  const args = buildArgs(input, outputFile);

  const child = spawn(relayConfig.codexBin, args, {
    cwd: relayConfig.codexCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  let sessionId = input.sessionId;
  const jsonErrors: string[] = [];
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];

  const consumeLine = (line: string, source: "stdout" | "stderr"): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (source === "stderr") {
      stderrLines.push(trimmed);
    } else {
      stdoutLines.push(trimmed);
    }

    try {
      const event = JSON.parse(trimmed) as CodexEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }

      if (event.type === "error" && typeof event.message === "string") {
        jsonErrors.push(event.message);
      }

      if (event.type === "turn.failed" && typeof event.error?.message === "string") {
        jsonErrors.push(event.error.message);
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  };

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => consumeLine(line, "stdout"));

  const stderrRl = readline.createInterface({ input: child.stderr });
  stderrRl.on("line", (line) => consumeLine(line, "stderr"));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  stdoutRl.close();
  stderrRl.close();

  let reply = "";
  try {
    reply = (await fs.readFile(outputFile, "utf8")).trim();
  } catch {
    reply = "";
  }

  await fs.rm(tempDir, { recursive: true, force: true });

  if (exitCode !== 0 && reply.length === 0) {
    const details =
      jsonErrors.at(-1) ??
      stderrLines.at(-1) ??
      stdoutLines.at(-1) ??
      `Codex process exited with code ${exitCode}`;
    throw new Error(details);
  }

  return {
    reply: reply || "Codex completed but returned an empty message.",
    sessionId
  };
}
