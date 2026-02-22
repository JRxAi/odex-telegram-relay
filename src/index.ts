import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relayConfig } from "./config.js";
import { createRelayBot } from "./telegram-relay.js";

const execFileAsync = promisify(execFile);

async function verifyCodexCli(): Promise<void> {
  try {
    await execFileAsync(relayConfig.codexBin, ["--version"]);
  } catch (error) {
    throw new Error(
      `Failed to execute Codex CLI (${relayConfig.codexBin}). Install Codex and ensure it is in PATH.`,
      { cause: error as Error }
    );
  }
}

async function main(): Promise<void> {
  await verifyCodexCli();

  const bot = createRelayBot();

  const botInfo = await bot.api.getMe();
  console.log(`Starting bot @${botInfo.username} in ${relayConfig.codexCwd}`);
  console.log(`Codex sandbox mode: ${relayConfig.codexSandbox}`);

  const stop = (signal: string): void => {
    console.log(`Stopping bot (${signal})`);
    bot.stop();
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  bot.start({ drop_pending_updates: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
