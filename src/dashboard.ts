import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

loadDotEnv();

type SessionEntry = {
  chatId: string;
  sessionId: string;
};

type ChatMemoryEntry = {
  chatId: string;
  filePath: string;
  updatedAt: string;
  lineCount: number;
  preview: string;
};

type DashboardState = {
  generatedAt: string;
  process: {
    pid: number;
    nodeVersion: string;
    cwd: string;
    uptimeSec: number;
  };
  relay: {
    codexCwd: string;
    codexSandbox: string;
    codexModel: string;
    maxReplyChars: number;
    transcriptionModel: string;
    voiceEnabled: boolean;
  };
  backends: {
    supabaseConfigured: boolean;
    localFileMemoryEnabled: boolean;
  };
  files: {
    sessionsFile: string;
    soulFile: string;
    memoryFile: string;
    chatMemoryDir: string;
    relayLogFile: string;
  };
  sessions: SessionEntry[];
  localMemory: {
    soulPreview: string;
    memoryPreview: string;
    chatFiles: ChatMemoryEntry[];
  };
  logs: {
    relayTail: string;
  };
};

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value.trim() || fallback;
}

function parseBool(raw: string, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntSafe(raw: string, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function trimPreview(text: string, maxChars: number): string {
  const compact = text.trim();
  if (!compact) {
    return "(empty)";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return compact.slice(0, maxChars - 1).trimEnd() + "…";
}

async function readTextSafe(filePath: string): Promise<string> {
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

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  const raw = await readTextSafe(filePath);
  if (!raw.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readTailSafe(filePath: string, maxBytes: number): Promise<string> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      if (stats.size <= 0) {
        return "(empty log)";
      }

      const length = Math.min(maxBytes, stats.size);
      const start = Math.max(0, stats.size - length);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8").trim() || "(empty log)";
    } finally {
      await handle.close();
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "relay.log not found";
    }
    return `Failed to read relay log: ${err.message}`;
  }
}

async function readChatMemorySummaries(chatMemoryDir: string, previewChars: number): Promise<ChatMemoryEntry[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(chatMemoryDir, { encoding: "utf8" });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const result: ChatMemoryEntry[] = [];

  for (const fileName of entries) {
    if (!fileName.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(chatMemoryDir, fileName);
    const [content, stat] = await Promise.all([readTextSafe(filePath), fs.stat(filePath)]);
    const lineCount = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;

    result.push({
      chatId: fileName.replace(/\.md$/, ""),
      filePath,
      updatedAt: stat.mtime.toISOString(),
      lineCount,
      preview: trimPreview(content, previewChars)
    });
  }

  result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

async function gatherState(): Promise<DashboardState> {
  const cwd = process.cwd();
  const sessionsFile = path.resolve(cwd, env("SESSIONS_FILE", ".data/sessions.json"));
  const soulFile = path.resolve(cwd, env("SOUL_FILE", "soul.md"));
  const memoryFile = path.resolve(cwd, env("MEMORY_FILE", "memory.md"));
  const chatMemoryDir = path.resolve(cwd, env("CHAT_MEMORY_DIR", ".data/chat-memory"));
  const relayLogFile = path.resolve(cwd, ".data/relay.log");
  const previewChars = parseIntSafe(env("LOCAL_MEMORY_PREVIEW_CHARS", "900"), 900);

  const [sessionMap, soulRaw, memoryRaw, chatFiles, relayTail] = await Promise.all([
    readJsonSafe<Record<string, string>>(sessionsFile, {}),
    readTextSafe(soulFile),
    readTextSafe(memoryFile),
    readChatMemorySummaries(chatMemoryDir, previewChars),
    readTailSafe(relayLogFile, 24000)
  ]);

  const sessions: SessionEntry[] = Object.entries(sessionMap)
    .map(([chatId, sessionId]) => ({ chatId, sessionId }))
    .sort((a, b) => a.chatId.localeCompare(b.chatId));

  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      cwd,
      uptimeSec: Math.round(process.uptime())
    },
    relay: {
      codexCwd: path.resolve(cwd, env("CODEX_CWD", ".")),
      codexSandbox: env("CODEX_SANDBOX", "workspace-write"),
      codexModel: env("CODEX_MODEL", "(default)"),
      maxReplyChars: parseIntSafe(env("MAX_REPLY_CHARS", "3800"), 3800),
      transcriptionModel: env("TRANSCRIPTION_MODEL", "whisper-large-v3-turbo"),
      voiceEnabled: Boolean(env("GROQ_API_KEY"))
    },
    backends: {
      supabaseConfigured: Boolean(env("SUPABASE_URL")) && Boolean(env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY")),
      localFileMemoryEnabled: parseBool(env("LOCAL_MEMORY_ENABLED", "true"), true)
    },
    files: {
      sessionsFile,
      soulFile,
      memoryFile,
      chatMemoryDir,
      relayLogFile
    },
    sessions,
    localMemory: {
      soulPreview: trimPreview(soulRaw, previewChars),
      memoryPreview: trimPreview(memoryRaw, previewChars),
      chatFiles
    },
    logs: {
      relayTail
    }
  };
}

function jsonResponse(body: unknown): string {
  return JSON.stringify(body);
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Odex Relay Dashboard</title>
  <style>
    :root {
      --bg-a: #f2f7f6;
      --bg-b: #fdeed9;
      --ink: #142220;
      --muted: #47605a;
      --card: rgba(255, 255, 255, 0.82);
      --line: rgba(20, 34, 32, 0.1);
      --accent: #0f7c66;
      --accent-2: #e06d3b;
      --ok: #2b8a3e;
      --warn: #a66d00;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Space Grotesk", "IBM Plex Sans", "Avenir Next", sans-serif;
      background:
        radial-gradient(1000px 500px at 10% -10%, rgba(15,124,102,0.18), transparent 65%),
        radial-gradient(900px 460px at 110% 0%, rgba(224,109,59,0.22), transparent 60%),
        linear-gradient(140deg, var(--bg-a), var(--bg-b));
      min-height: 100vh;
    }
    .wrap {
      width: min(1220px, 95vw);
      margin: 30px auto 40px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
      margin-bottom: 16px;
    }
    .title {
      font-size: clamp(1.4rem, 2.1vw, 2.4rem);
      margin: 0;
      letter-spacing: 0.01em;
    }
    .stamp {
      color: var(--muted);
      font-size: 0.92rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px 15px;
      backdrop-filter: blur(6px);
      box-shadow: 0 6px 26px rgba(20, 34, 32, 0.08);
      animation: rise 220ms ease-out;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(5px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    @media (max-width: 920px) {
      .span-3, .span-4, .span-6, .span-8, .span-12 { grid-column: span 12; }
    }
    h2 {
      margin: 0 0 10px;
      font-size: 0.98rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }
    .kpi {
      font-size: 1.8rem;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .row { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--line); }
    .row:last-child { border-bottom: none; }
    .label { color: var(--muted); }
    .value { text-align: right; font-family: "IBM Plex Mono", "Menlo", monospace; font-size: 0.88rem; }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      border: 1px solid var(--line);
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .ok { color: var(--ok); background: rgba(43,138,62,0.09); }
    .warn { color: var(--warn); background: rgba(166,109,0,0.1); }
    .bad { color: var(--bad); background: rgba(180,35,24,0.08); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.84rem;
    }
    th, td {
      text-align: left;
      padding: 8px 5px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      word-break: break-all;
    }
    th { color: var(--muted); font-weight: 700; }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 11px;
      background: rgba(20,34,32,0.91);
      color: #edf8f4;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.8rem;
      line-height: 1.4;
      white-space: pre-wrap;
      max-height: 340px;
      overflow: auto;
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 780px) {
      .split { grid-template-columns: 1fr; }
    }
    .small {
      color: var(--muted);
      font-size: 0.78rem;
      margin-top: 6px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1 class="title">Odex Relay Dashboard</h1>
      <div class="stamp" id="stamp">loading...</div>
    </div>
    <div class="grid">
      <section class="card span-3">
        <h2>Sessions</h2>
        <div class="kpi" id="kpi-sessions">0</div>
        <div class="small" id="sessions-file"></div>
      </section>
      <section class="card span-3">
        <h2>Voice</h2>
        <div id="voice-state" class="pill warn">unknown</div>
        <div class="small" id="voice-model"></div>
      </section>
      <section class="card span-3">
        <h2>Supabase</h2>
        <div id="supabase-state" class="pill warn">unknown</div>
        <div class="small">long-term db memory</div>
      </section>
      <section class="card span-3">
        <h2>Local Files</h2>
        <div id="local-state" class="pill warn">unknown</div>
        <div class="small">soul.md / memory.md</div>
      </section>

      <section class="card span-6">
        <h2>Relay Config</h2>
        <div id="relay-rows"></div>
      </section>

      <section class="card span-6">
        <h2>Process</h2>
        <div id="process-rows"></div>
      </section>

      <section class="card span-6">
        <h2>Active Session Map</h2>
        <div id="sessions-table"></div>
      </section>

      <section class="card span-6">
        <h2>Chat Memory Files</h2>
        <div id="chat-memory-table"></div>
      </section>

      <section class="card span-12">
        <h2>Soul + Memory Preview</h2>
        <div class="split">
          <pre id="soul-preview"></pre>
          <pre id="memory-preview"></pre>
        </div>
      </section>

      <section class="card span-12">
        <h2>Relay Log Tail</h2>
        <pre id="relay-log"></pre>
      </section>
    </div>
  </div>
  <script>
    function pill(el, label, kind) {
      el.textContent = label;
      el.className = "pill " + kind;
    }

    function row(label, value) {
      return '<div class="row"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    }

    function esc(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function table(headers, rows) {
      if (!rows.length) return '<div class="small">(no data)</div>';
      const head = "<tr>" + headers.map(h => "<th>" + esc(h) + "</th>").join("") + "</tr>";
      const body = rows.map(r => "<tr>" + r.map(c => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("");
      return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
    }

    async function loadState() {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error("Dashboard API failed: " + res.status);
      return res.json();
    }

    function render(state) {
      document.getElementById("stamp").textContent =
        "updated " + new Date(state.generatedAt).toLocaleTimeString();

      document.getElementById("kpi-sessions").textContent = String(state.sessions.length);
      document.getElementById("sessions-file").textContent = state.files.sessionsFile;
      document.getElementById("voice-model").textContent = "model: " + state.relay.transcriptionModel;

      pill(
        document.getElementById("voice-state"),
        state.relay.voiceEnabled ? "enabled" : "disabled",
        state.relay.voiceEnabled ? "ok" : "warn"
      );
      pill(
        document.getElementById("supabase-state"),
        state.backends.supabaseConfigured ? "configured" : "not configured",
        state.backends.supabaseConfigured ? "ok" : "warn"
      );
      pill(
        document.getElementById("local-state"),
        state.backends.localFileMemoryEnabled ? "enabled" : "disabled",
        state.backends.localFileMemoryEnabled ? "ok" : "warn"
      );

      document.getElementById("relay-rows").innerHTML =
        row("codexCwd", state.relay.codexCwd) +
        row("codexSandbox", state.relay.codexSandbox) +
        row("codexModel", state.relay.codexModel) +
        row("maxReplyChars", state.relay.maxReplyChars) +
        row("chatMemoryDir", state.files.chatMemoryDir);

      document.getElementById("process-rows").innerHTML =
        row("pid", state.process.pid) +
        row("node", state.process.nodeVersion) +
        row("uptimeSec", state.process.uptimeSec) +
        row("cwd", state.process.cwd);

      document.getElementById("sessions-table").innerHTML = table(
        ["chatId", "sessionId"],
        state.sessions.map(s => [s.chatId, s.sessionId])
      );

      document.getElementById("chat-memory-table").innerHTML = table(
        ["chatId", "lineCount", "updatedAt", "preview"],
        state.localMemory.chatFiles.map(item => [
          item.chatId,
          String(item.lineCount),
          new Date(item.updatedAt).toLocaleString(),
          item.preview
        ])
      );

      document.getElementById("soul-preview").textContent = state.localMemory.soulPreview;
      document.getElementById("memory-preview").textContent = state.localMemory.memoryPreview;
      document.getElementById("relay-log").textContent = state.logs.relayTail;
    }

    async function refresh() {
      try {
        const state = await loadState();
        render(state);
      } catch (error) {
        document.getElementById("stamp").textContent = "error: " + error.message;
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  void __dirname;

  const host = env("DASHBOARD_HOST", "127.0.0.1");
  const port = parseIntSafe(env("DASHBOARD_PORT", "4243"), 4243);

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (pathname === "/api/state") {
        const state = await gatherState();
        const payload = jsonResponse(state);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(payload)
        });
        res.end(payload);
        return;
      }

      if (pathname === "/") {
        const payload = htmlPage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(payload)
        });
        res.end(payload);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(jsonResponse({ error: message }));
    }
  });

  server.listen(port, host, () => {
    console.log(`Dashboard running on http://${host}:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
