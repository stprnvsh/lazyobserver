/**
 * End-of-day distillation.
 *
 * gather -> distill -> apply:
 *  - gather: pull the day's sessions, event stats, journal notes and the
 *    conversation narrative from the store (reads only).
 *  - distill: one `claude -p` call (the user's own account) that turns the
 *    material into STRICT JSON: a day document, codebase-memory upserts and
 *    decision records. Injectable runner; `--offline` produces a mechanical
 *    day doc with zero LLM.
 *  - apply: queue everything through the spool (the daemon stays the single
 *    writer), then project MEMORY.md blocks per repo.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

import {
  localDate,
  paths,
  Store,
  TABLES,
} from "@lazyobserver/core";
import { queueMemWrite } from "@lazyobserver/daemon/memwrite";

// --------------------------------------------------------------------------
// gather
// --------------------------------------------------------------------------

export interface DayMaterial {
  date: string;
  sessions: {
    id: string;
    repo: string;
    workspace: string;
    branch: string;
    surface: string;
    model: string;
    minutes: number;
    tokens_in: number;
    tokens_out: number;
  }[];
  eventStats: Record<string, number>; // kind -> count
  filesEdited: string[];
  commands: string[];
  notes: { title: string; body: string }[];
  narrative: { role: string; content: string }[]; // capped conversation text
}

function dayRangeMs(date: string): { from: number; to: number } {
  return {
    from: Date.parse(`${date}T00:00:00`),
    to: Date.parse(`${date}T23:59:59.999`),
  };
}

export async function gatherDayMaterial(
  store: Store,
  date: string,
): Promise<DayMaterial> {
  const { from, to } = dayRangeMs(date);

  const sessions = (
    (await (await store.table(TABLES.sessions))
      .query()
      .where(`ended_at >= ${from} AND started_at <= ${to}`)
      .limit(500)
      .toArray()) as Record<string, unknown>[]
  ).map((s) => ({
    id: String(s.id),
    repo: String(s.repo ?? ""),
    workspace: String(s.workspace ?? ""),
    branch: String(s.branch ?? ""),
    surface: String(s.surface ?? ""),
    model: String(s.model ?? ""),
    minutes: Math.max(
      0,
      Math.round((Number(s.ended_at) - Number(s.started_at)) / 60_000),
    ),
    tokens_in: Number(s.tokens_in ?? 0),
    tokens_out: Number(s.tokens_out ?? 0),
  }));

  const events = (await (await store.table(TABLES.events))
    .query()
    .where(`ts >= ${from} AND ts <= ${to}`)
    .limit(20_000)
    .toArray()) as Record<string, unknown>[];
  const eventStats: Record<string, number> = {};
  const filesEdited = new Set<string>();
  const commands: string[] = [];
  for (const e of events) {
    const kind = String(e.kind);
    eventStats[kind] = (eventStats[kind] ?? 0) + 1;
    try {
      const payload = JSON.parse(String(e.payload ?? "{}"));
      const input = payload.tool_input ?? {};
      if (kind === "file_edit" && input.file_path)
        filesEdited.add(String(input.file_path));
      if (kind === "command" && input.command && commands.length < 60)
        commands.push(String(input.command).slice(0, 160));
    } catch {
      /* payload not JSON — skip detail */
    }
  }

  const notes = (
    (await (await store.table(TABLES.dailyMemory))
      .query()
      .where(`date = '${date}' AND kind = 'entry'`)
      .limit(200)
      .toArray()) as Record<string, unknown>[]
  ).map((n) => ({ title: String(n.title ?? ""), body: String(n.body ?? "") }));

  const messages = (
    (await (await store.table(TABLES.messages))
      .query()
      .where(`ts >= ${from} AND ts <= ${to}`)
      .limit(4_000)
      .toArray()) as Record<string, unknown>[]
  ).sort((a, b) => Number(a.ts) - Number(b.ts));

  // Cap the narrative: keep it representative, newest-complete, ~60KB.
  const narrative: { role: string; content: string }[] = [];
  let budget = 60_000;
  for (const m of messages) {
    const content = String(m.content ?? "").slice(0, 700);
    if (budget - content.length < 0) break;
    budget -= content.length;
    narrative.push({ role: String(m.role), content });
  }

  return {
    date,
    sessions,
    eventStats,
    filesEdited: [...filesEdited].slice(0, 120),
    commands,
    notes,
    narrative,
  };
}

// --------------------------------------------------------------------------
// distill
// --------------------------------------------------------------------------

export interface Distillation {
  day_doc: { title: string; body: string };
  memory_upserts: {
    kind: string;
    title: string;
    body: string;
    repo?: string;
    supersedes?: string;
  }[];
  decisions: {
    context: string;
    options: string[];
    choice: string;
    rationale: string;
    proposed_by: string;
    decided_by: string;
    repo?: string;
  }[];
}

export function buildDistillPrompt(material: DayMaterial): string {
  return `You are the end-of-day memory distiller for a software engineer's work-observability tool.
Analyse the day's material below and return ONLY a JSON object (no markdown fence, no prose) with this exact shape:
{
  "day_doc": {"title": "...", "body": "markdown: what was worked on, what was discussed, the thought process, what the USER contributed vs what the AGENT did, open threads"},
  "memory_upserts": [{"kind": "decision|feature|gotcha|runbook|reference|preference", "title": "...", "body": "durable knowledge about the CODEBASE worth remembering long-term", "repo": "/abs/path/if/known"}],
  "decisions": [{"context": "...", "options": ["..."], "choice": "...", "rationale": "...", "proposed_by": "user|agent", "decided_by": "user|agent", "repo": "/abs/path/if/known"}]
}
Rules: memory_upserts must be DURABLE codebase knowledge (architecture, gotchas, how things work) — not activity logs. The day_doc IS the activity narrative. Extract real decisions with their why. Be faithful to the material; do not invent. Empty arrays are fine.

MATERIAL (${material.date}):
sessions: ${JSON.stringify(material.sessions)}
event_counts: ${JSON.stringify(material.eventStats)}
files_edited: ${JSON.stringify(material.filesEdited)}
commands_sample: ${JSON.stringify(material.commands.slice(0, 30))}
journal_notes: ${JSON.stringify(material.notes)}
conversation:
${material.narrative.map((n) => `[${n.role}] ${n.content}`).join("\n")}`;
}

export type DistillRunner = (prompt: string) => Promise<string>;

/** Default runner: headless `claude -p` on the user's own account. */
export const claudeRunner: DistillRunner = (prompt) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolve(parsed.result ?? stdout);
      } catch {
        resolve(stdout);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });

export function parseDistillation(raw: string): Distillation {
  // tolerate accidental markdown fences or prose around the JSON
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("distiller returned no JSON");
  const d = JSON.parse(raw.slice(start, end + 1)) as Partial<Distillation>;
  return {
    day_doc: {
      title: d.day_doc?.title ?? "Day document",
      body: d.day_doc?.body ?? "",
    },
    memory_upserts: Array.isArray(d.memory_upserts) ? d.memory_upserts : [],
    decisions: Array.isArray(d.decisions) ? d.decisions : [],
  };
}

/** Mechanical fallback — no LLM, still a useful day doc. */
export function offlineDistillation(material: DayMaterial): Distillation {
  const repos = [...new Set(material.sessions.map((s) => s.repo))].filter(Boolean);
  const body = [
    `## Sessions (${material.sessions.length})`,
    ...material.sessions.map(
      (s) =>
        `- ${s.id.slice(0, 8)} — ${s.repo.split("/").pop()}@${s.branch} (${s.surface}, ${s.minutes}m, ${s.tokens_in + s.tokens_out} tok)`,
    ),
    `\n## Activity`,
    ...Object.entries(material.eventStats).map(([k, v]) => `- ${k}: ${v}`),
    material.filesEdited.length
      ? `\n## Files edited (${material.filesEdited.length})\n` +
        material.filesEdited.slice(0, 40).map((f) => `- ${f}`).join("\n")
      : "",
    material.notes.length
      ? `\n## Journal notes\n` +
        material.notes.map((n) => `- ${n.title || n.body.slice(0, 100)}`).join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    day_doc: {
      title: `Work on ${material.date} (${repos.map((r) => r.split("/").pop()).join(", ")})`,
      body,
    },
    memory_upserts: [],
    decisions: [],
  };
}

// --------------------------------------------------------------------------
// apply
// --------------------------------------------------------------------------

export interface ApplyResult {
  dayDocId: string;
  memoryIds: string[];
  decisionIds: string[];
}

export async function applyDistillation(
  d: Distillation,
  date: string,
  workspaces: string[],
): Promise<ApplyResult> {
  const now = Date.now();
  const dayDocId = `day-${date}`;
  await queueMemWrite({
    table: TABLES.dailyMemory,
    row: {
      id: dayDocId,
      date,
      kind: "day_doc",
      workspaces: JSON.stringify(workspaces),
      title: d.day_doc.title,
      body: d.day_doc.body,
      session_id: "",
      created_at: now,
    },
  });

  const memoryIds: string[] = [];
  for (const m of d.memory_upserts) {
    const id = `mem-${now}-${memoryIds.length}-${Math.random().toString(36).slice(2, 6)}`;
    memoryIds.push(id);
    await queueMemWrite({
      table: TABLES.codebaseMemory,
      row: {
        id,
        repo: m.repo ?? "",
        scope: "repo",
        kind: m.kind || "feature",
        title: m.title,
        body: m.body,
        status: "active",
        supersedes: m.supersedes ?? "",
        created_at: now,
        updated_at: now,
        source_session: `eod-${date}`,
      },
    });
  }

  const decisionIds: string[] = [];
  for (const dec of d.decisions) {
    const id = `dec-${now}-${decisionIds.length}-${Math.random().toString(36).slice(2, 6)}`;
    decisionIds.push(id);
    await queueMemWrite({
      table: TABLES.decisions,
      row: {
        id,
        date,
        session_id: "",
        repo: dec.repo ?? "",
        context: dec.context,
        options: JSON.stringify(dec.options ?? []),
        choice: dec.choice,
        rationale: dec.rationale,
        proposed_by: dec.proposed_by || "user",
        decided_by: dec.decided_by || "user",
        links: "{}",
      },
    });
  }

  return { dayDocId, memoryIds, decisionIds };
}

/** Wait for the daemon to drain queued mem writes (so projection sees them). */
export async function waitForSpoolDrain(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pending = (await readdir(paths.spool())).filter((f) =>
        f.startsWith("mem-"),
      );
      if (pending.length === 0) return true;
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export { localDate };
