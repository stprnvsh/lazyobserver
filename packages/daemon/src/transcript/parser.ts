/**
 * Parser for Claude Code transcript JSONL lines.
 *
 * Verified against a real 163 MB transcript (2026-07): line `type`s include
 * user, assistant, system, summary, queue-operation, attachment, ai-title,
 * file-history-snapshot, last-prompt, mode, pr-link... We whitelist
 * user/assistant and extract:
 *   - text blocks        -> role "user" | "assistant"
 *   - thinking blocks    -> role "thinking" (the agent's thought process —
 *                           first-class for daily-memory queries)
 *   - usage on assistant -> token accounting per session
 *   - entrypoint         -> surface ("claude-vscode" => vscode)
 * tool_use/tool_result blocks are NOT turned into messages — the hook spool
 * already carries the granular tool trace (events table).
 */

export interface ParsedMessage {
  uuid: string;
  sessionId: string;
  ts: number;
  role: "user" | "assistant" | "thinking";
  text: string;
  blockIx: number;
  /** true for MID-TURN prompts (queued while the agent worked) — these fire
   * NO UserPromptSubmit hook, so the tailer synthesizes their prompt event */
  queuedPrompt?: boolean;
}

export interface ParsedLineMeta {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  surface?: "vscode" | "cli";
  model?: string;
  ts?: number;
  usage?: { input: number; output: number };
}

export interface ParsedLine {
  messages: ParsedMessage[];
  meta: ParsedLineMeta | null;
}

function surfaceFromEntrypoint(e: unknown): "vscode" | "cli" | undefined {
  if (typeof e !== "string") return undefined;
  return e.includes("vscode") ? "vscode" : "cli";
}

export function parseTranscriptLine(line: string): ParsedLine {
  const empty: ParsedLine = { messages: [], meta: null };
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const type = d.type;
  if (type !== "user" && type !== "assistant" && type !== "attachment")
    return empty;

  const sessionId = typeof d.sessionId === "string" ? d.sessionId : "";
  if (!sessionId) return empty;

  // Mid-turn user prompts land as attachment lines (attachment.type =
  // "queued_command" with prompt blocks) — verified live 2026-07-10; they
  // fire NO hook, so the transcript is their ONLY capture path.
  if (type === "attachment") {
    const att = d.attachment as
      | { type?: string; prompt?: unknown }
      | undefined;
    if (att?.type !== "queued_command" || !Array.isArray(att.prompt))
      return empty;
    const ts0 = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    const uuid0 = typeof d.uuid === "string" ? d.uuid : "";
    if (!uuid0) return empty;
    const messages: ParsedMessage[] = [];
    att.prompt.forEach((block, ix) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string"
      ) {
        const text = (block as { text: string }).text.trim();
        if (text)
          messages.push({
            uuid: uuid0,
            sessionId,
            ts: Number.isFinite(ts0) ? ts0 : Date.now(),
            role: "user",
            text,
            blockIx: ix,
            queuedPrompt: true,
          });
      }
    });
    return {
      messages,
      meta: {
        sessionId,
        cwd: typeof d.cwd === "string" ? d.cwd : undefined,
        gitBranch: typeof d.gitBranch === "string" ? d.gitBranch : undefined,
        surface: surfaceFromEntrypoint(d.entrypoint),
        ts: Number.isFinite(ts0) ? ts0 : undefined,
      },
    };
  }

  const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  const message = (d.message ?? {}) as Record<string, unknown>;
  const uuid = typeof d.uuid === "string" ? d.uuid : "";

  const meta: ParsedLineMeta = {
    sessionId,
    cwd: typeof d.cwd === "string" ? d.cwd : undefined,
    gitBranch: typeof d.gitBranch === "string" ? d.gitBranch : undefined,
    surface: surfaceFromEntrypoint(d.entrypoint),
    ts: Number.isFinite(ts) ? ts : undefined,
  };

  if (type === "assistant") {
    if (typeof message.model === "string") meta.model = message.model;
    const usage = message.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (usage) {
      meta.usage = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      };
    }
  }

  const messages: ParsedMessage[] = [];
  if (uuid) {
    const content = message.content;
    const push = (
      role: ParsedMessage["role"],
      text: string,
      blockIx: number,
    ): void => {
      const trimmed = text.trim();
      if (trimmed)
        messages.push({
          uuid,
          sessionId,
          ts: Number.isFinite(ts) ? ts : Date.now(),
          role,
          text: trimmed,
          blockIx,
        });
    };

    const baseRole = type === "user" ? "user" : "assistant";
    if (typeof content === "string") {
      push(baseRole, content, 0);
    } else if (Array.isArray(content)) {
      content.forEach((block, ix) => {
        if (!block || typeof block !== "object") return;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          push(baseRole, b.text, ix);
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          push("thinking", b.thinking, ix);
        }
        // tool_use / tool_result / image / document: trace lives in events
      });
    }
  }

  return { messages, meta };
}
