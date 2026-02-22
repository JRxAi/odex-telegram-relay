import fs from "node:fs/promises";
import path from "node:path";

type SessionMap = Record<string, string>;

export class SessionStore {
  private readonly filePath: string;
  private loaded = false;
  private sessions = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async get(chatId: number): Promise<string | undefined> {
    await this.loadOnce();
    return this.sessions.get(String(chatId));
  }

  public async set(chatId: number, sessionId: string): Promise<void> {
    await this.loadOnce();
    this.sessions.set(String(chatId), sessionId);
    await this.persistQueued();
  }

  public async clear(chatId: number): Promise<void> {
    await this.loadOnce();
    this.sessions.delete(String(chatId));
    await this.persistQueued();
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loaded = true;

    try {
      const payload = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(payload) as SessionMap;
      for (const [chatId, sessionId] of Object.entries(parsed)) {
        if (typeof sessionId === "string" && sessionId.length > 0) {
          this.sessions.set(chatId, sessionId);
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async persistQueued(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
      await fs.writeFile(this.filePath, payload + "\n", "utf8");
    });

    await this.writeQueue;
  }
}
