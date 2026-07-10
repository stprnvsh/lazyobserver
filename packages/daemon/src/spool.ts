/**
 * Spool ingestion: hook-emitted event files -> `events` rows.
 *
 * Each spool file is one hook firing: the hook JSON payload (as Claude Code
 * wrote it to the script's stdin) followed by a final `_lzo` envelope line
 * (surface hints + timestamp). Files are deleted only AFTER a successful
 * flush — at-least-once, made harmless by filename-derived deterministic ids.
 */
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import {
  loadConfig,
  normalizeRepoPath,
  paths,
  redactRecord,
  redactSecrets,
  workspacesForRepo,
  type Config,
} from "@lazyobserver/core";

import type { EventRow, Writer } from "./ingest/writer.js";
import { embeddingText, isMemFile, type MemWrite } from "./memwrite.js";

const PAYLOAD_CAP = 8 * 1024;

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface LzoEnvelope {
  term?: string;
  bundle?: string;
  /** LAZYOBSERVER_TASK_ID from the SESSION's env (set by `lzo work`) */
  task?: string;
  ts?: number;
}

export interface SpoolEvent {
  payload: Record<string, unknown>;
  envelope: LzoEnvelope;
}

/** Parse a spool file: JSON payload + trailing `{"_lzo":{...}}` line. */
export function parseSpoolFile(content: string): SpoolEvent | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const lastNl = trimmed.lastIndexOf("\n");
  let payloadPart = trimmed;
  let envelope: LzoEnvelope = {};
  if (lastNl >= 0) {
    const lastLine = trimmed.slice(lastNl + 1);
    try {
      const parsed = JSON.parse(lastLine) as { _lzo?: LzoEnvelope };
      if (parsed._lzo) {
        envelope = parsed._lzo;
        payloadPart = trimmed.slice(0, lastNl);
      }
    } catch {
      /* no envelope — whole content is payload */
    }
  }
  try {
    return {
      payload: JSON.parse(payloadPart) as Record<string, unknown>,
      envelope,
    };
  } catch {
    return null;
  }
}

export function surfaceFromEnvelope(env: LzoEnvelope): string {
  const term = (env.term ?? "").toLowerCase();
  const bundle = (env.bundle ?? "").toLowerCase();
  if (term.includes("vscode") || bundle.includes("vscode")) return "vscode";
  if (term || bundle) return "cli";
  return "unknown";
}

function kindAndActor(payload: Record<string, unknown>): {
  kind: string;
  actor: string;
} {
  const event = String(payload.hook_event_name ?? "unknown");
  switch (event) {
    case "UserPromptSubmit":
      return { kind: "prompt", actor: "user" };
    case "PostToolUse": {
      const tool = String(payload.tool_name ?? "");
      if (FILE_EDIT_TOOLS.has(tool)) return { kind: "file_edit", actor: "agent" };
      if (tool === "Bash") return { kind: "command", actor: "agent" };
      return { kind: "tool_call", actor: "agent" };
    }
    case "SessionStart":
      return { kind: "session_start", actor: "system" };
    case "SessionEnd":
      return { kind: "session_end", actor: "system" };
    case "Stop":
      return { kind: "stop", actor: "system" };
    case "SubagentStop":
      return { kind: "subagent_stop", actor: "system" };
    case "PreCompact":
      return { kind: "pre_compact", actor: "system" };
    default:
      return { kind: event.toLowerCase(), actor: "system" };
  }
}

function capPayload(payload: Record<string, unknown>): string {
  const full = JSON.stringify(payload);
  if (full.length <= PAYLOAD_CAP) return full;
  // Keep the identifying fields, truncating every unbounded string —
  // the result must be VALID JSON BY CONSTRUCTION. (Blind-slicing the
  // stringified object once cut a huge prompt mid-string; the invalid row
  // then broke every consumer that parsed payloads.)
  const slim: Record<string, unknown> = {
    _truncated: true,
    _bytes: full.length,
  };
  for (const key of ["hook_event_name", "session_id", "cwd", "tool_name"]) {
    if (payload[key] !== undefined) slim[key] = payload[key];
  }
  if (typeof payload.prompt === "string") {
    slim.prompt = payload.prompt.slice(0, 2000);
  }
  const input = payload.tool_input as Record<string, unknown> | undefined;
  if (input) {
    slim.tool_input = {
      file_path: input.file_path,
      command: typeof input.command === "string" ? input.command.slice(0, 2000) : undefined,
      description: typeof input.description === "string" ? input.description.slice(0, 500) : undefined,
    };
  }
  const out = JSON.stringify(slim);
  // belt-and-braces: if somehow still over cap, drop to a minimal valid object
  return out.length <= PAYLOAD_CAP
    ? out
    : JSON.stringify({
        _truncated: true,
        _bytes: full.length,
        hook_event_name: payload.hook_event_name,
        session_id: payload.session_id,
      });
}

export function toEventRow(
  fileName: string,
  evt: SpoolEvent,
  cfg: Config,
): EventRow {
  const payload = evt.payload;
  const { kind, actor } = kindAndActor(payload);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const repo = cwd ? normalizeRepoPath(cwd) : "";
  const workspaces = repo ? workspacesForRepo(cfg, repo) : [];
  return {
    id: fileName.replace(/^evt-/, "").replace(/\.json$/, ""),
    ts: evt.envelope.ts ?? Date.now(),
    session_id: String(payload.session_id ?? ""),
    surface: surfaceFromEnvelope(evt.envelope),
    actor,
    kind,
    repo,
    workspace: workspaces.map((w) => w.name).join(",") || "",
    branch: "",
    task_id: String(evt.envelope.task ?? ""),
    payload: cfg.settings.redaction.enabled
      ? redactSecrets(capPayload(payload)).text
      : capPayload(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

/** One sweep: parse every spool file, queue rows, flush, delete files. */
export async function processSpoolOnce(writer: Writer): Promise<number> {
  const dir = paths.spool();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const cfgForRedaction = await loadConfig();
  const redactionOn = cfgForRedaction.settings.redaction.enabled;

  // memory-plane writes queued by MCP / import / eod (single-writer protocol)
  const memFiles = entries.filter(isMemFile);
  let memIngested = 0;
  for (const file of memFiles) {
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const write = JSON.parse(content) as MemWrite;
      if (write.table && write.row && typeof write.row.id === "string") {
        const row = redactionOn ? redactRecord(write.row).row : write.row;
        await writer.upsertMemoryRow(
          write.table,
          row,
          embeddingText(write.table, row),
        );
      }
      await unlink(path.join(dir, file)).catch(() => undefined);
      memIngested++;
    } catch {
      /* unreadable right now — retry next sweep */
    }
  }

  const files = entries.filter(
    (f) => f.startsWith("evt-") && f.endsWith(".json"),
  );
  if (files.length === 0) return memIngested;

  const cfg = await loadConfig();
  const ingested: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      const evt = parseSpoolFile(content);
      if (evt) {
        const row = toEventRow(file, evt, cfg);
        writer.queueEvent(row);
        if (row.session_id) {
          writer.touchSession({
            id: row.session_id,
            started_at: row.ts,
            ended_at: row.ts,
            repo: row.repo,
            workspace: row.workspace,
            surface: row.surface !== "unknown" ? row.surface : "",
          });
        }
      }
      ingested.push(file); // unparsable files are removed too (never re-loop)
    } catch {
      /* unreadable right now — retry next sweep */
    }
  }
  await writer.flush();
  await Promise.all(
    ingested.map((f) => unlink(path.join(dir, f)).catch(() => undefined)),
  );
  return ingested.length + memIngested;
}
