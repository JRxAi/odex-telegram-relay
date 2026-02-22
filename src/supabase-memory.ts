import { createClient } from "@supabase/supabase-js";
import { relayConfig } from "./config.js";

type ChatRole = "user" | "assistant" | "system";

type SaveChatMessageInput = {
  chatId: number;
  role: ChatRole;
  content: string;
  metadata?: Record<string, unknown>;
};

type SearchResult = {
  role?: string;
  content?: string;
  channel?: string;
};

const supabase =
  relayConfig.supabaseUrl && relayConfig.supabaseKey
    ? createClient(relayConfig.supabaseUrl, relayConfig.supabaseKey)
    : null;

const warned = new Set<string>();

function warnOnce(key: string, error: unknown): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.error(`[supabase] ${key}`, error);
}

function chatChannel(chatId: number): string {
  return `telegram:${chatId}`;
}

function compactText(text: string, max = 420): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  return compact.slice(0, max - 1).trimEnd() + "…";
}

function pushIfNonEmpty(parts: string[], value: string): void {
  if (value.trim()) {
    parts.push(value.trim());
  }
}

function fitContextBudget(parts: string[], maxChars: number): string {
  const joined = parts.join("\n\n").trim();
  if (joined.length <= maxChars) {
    return joined;
  }
  return joined.slice(0, maxChars - 1).trimEnd() + "…";
}

export function isSupabaseEnabled(): boolean {
  return Boolean(supabase);
}

export async function saveChatMessage(input: SaveChatMessageInput): Promise<void> {
  if (!supabase) {
    return;
  }

  const content = input.content.trim();
  if (!content) {
    return;
  }

  try {
    const { error } = await supabase.from("messages").insert({
      role: input.role,
      content,
      channel: chatChannel(input.chatId),
      metadata: {
        chat_id: input.chatId,
        ...(input.metadata ?? {})
      }
    });

    if (error) {
      throw error;
    }
  } catch (error) {
    warnOnce("save messages failed (check messages table/schema)", error);
  }
}

async function getRecentMessagesContext(chatId: number): Promise<string> {
  if (!supabase) {
    return "";
  }

  try {
    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("channel", chatChannel(chatId))
      .order("created_at", { ascending: false })
      .limit(relayConfig.supabaseRecentMessages);

    if (error) {
      throw error;
    }
    if (!data || data.length === 0) {
      return "";
    }

    const lines = data
      .slice()
      .reverse()
      .map((row) => `- [${row.role}] ${compactText(String(row.content ?? ""))}`)
      .filter((line) => line.length > 6);

    if (lines.length === 0) {
      return "";
    }

    return `RECENT CHAT HISTORY:\n${lines.join("\n")}`;
  } catch (error) {
    warnOnce("load recent context failed", error);
    return "";
  }
}

async function getStructuredMemoryContext(): Promise<string> {
  if (!supabase) {
    return "";
  }

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase
        .from("memory")
        .select("content")
        .eq("type", "fact")
        .order("updated_at", { ascending: false })
        .limit(10),
      supabase
        .from("memory")
        .select("content, deadline")
        .eq("type", "goal")
        .order("priority", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(10)
    ]);

    const facts: string[] = [];
    if (!factsResult.error && factsResult.data?.length) {
      for (const item of factsResult.data) {
        const content = String(item.content ?? "").trim();
        if (content) {
          facts.push(`- ${compactText(content, 240)}`);
        }
      }
    }

    const goals: string[] = [];
    if (!goalsResult.error && goalsResult.data?.length) {
      for (const item of goalsResult.data) {
        const content = String(item.content ?? "").trim();
        if (!content) {
          continue;
        }
        const deadline =
          typeof item.deadline === "string" && item.deadline.trim()
            ? ` (deadline: ${item.deadline.slice(0, 10)})`
            : "";
        goals.push(`- ${compactText(content, 220)}${deadline}`);
      }
    }

    const parts: string[] = [];
    if (facts.length > 0) {
      parts.push(`FACTS:\n${facts.join("\n")}`);
    }
    if (goals.length > 0) {
      parts.push(`ACTIVE GOALS:\n${goals.join("\n")}`);
    }
    return parts.join("\n\n");
  } catch (error) {
    // Structured memory is optional; no need to fail the turn.
    warnOnce("structured memory context unavailable", error);
    return "";
  }
}

async function getSemanticContext(chatId: number, query: string): Promise<string> {
  if (!supabase || !relayConfig.supabaseEnableSemanticSearch) {
    return "";
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return "";
  }

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query: trimmedQuery,
        match_count: relayConfig.supabaseSemanticMatches,
        table: "messages",
        channel: chatChannel(chatId)
      }
    });

    if (error) {
      throw error;
    }
    if (!Array.isArray(data) || data.length === 0) {
      return "";
    }

    const channel = chatChannel(chatId);
    const lines = (data as SearchResult[])
      .filter((item) => !item.channel || item.channel === channel)
      .slice(0, relayConfig.supabaseSemanticMatches)
      .map((item) => {
        const role = typeof item.role === "string" ? item.role : "unknown";
        const content = typeof item.content === "string" ? compactText(item.content) : "";
        return content ? `- [${role}] ${content}` : "";
      })
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return "";
    }

    return `SEMANTIC MEMORY MATCHES:\n${lines.join("\n")}`;
  } catch {
    // Edge function might not be deployed yet.
    return "";
  }
}

export async function buildSupabasePromptContext(chatId: number, query: string): Promise<string> {
  if (!supabase) {
    return "";
  }

  const [semantic, recent, structured] = await Promise.all([
    getSemanticContext(chatId, query),
    getRecentMessagesContext(chatId),
    getStructuredMemoryContext()
  ]);

  const parts: string[] = [];
  pushIfNonEmpty(parts, semantic);
  pushIfNonEmpty(parts, recent);
  pushIfNonEmpty(parts, structured);

  return fitContextBudget(parts, relayConfig.supabaseContextMaxChars);
}

export async function processMemoryIntents(response: string): Promise<string> {
  if (!supabase || !response.trim()) {
    return response;
  }

  let cleaned = response;

  try {
    for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
      const content = match[1]?.trim();
      if (content) {
        await supabase.from("memory").insert({
          type: "fact",
          content
        });
      }
      cleaned = cleaned.replace(match[0], "");
    }

    for (const match of response.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
      const content = match[1]?.trim();
      if (content) {
        await supabase.from("memory").insert({
          type: "goal",
          content,
          deadline: match[2]?.trim() || null
        });
      }
      cleaned = cleaned.replace(match[0], "");
    }

    for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
      const query = match[1]?.trim();
      if (query) {
        const { data } = await supabase
          .from("memory")
          .select("id")
          .eq("type", "goal")
          .ilike("content", `%${query}%`)
          .limit(1);

        if (data?.[0]?.id) {
          await supabase
            .from("memory")
            .update({
              type: "completed_goal",
              completed_at: new Date().toISOString()
            })
            .eq("id", data[0].id);
        }
      }

      cleaned = cleaned.replace(match[0], "");
    }
  } catch (error) {
    warnOnce("memory intents parsing failed", error);
    return response;
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
