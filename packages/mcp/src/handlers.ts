/**
 * MCP tool handlers — the agent-facing memory API.
 *
 * READS go straight to LanceDB (MVCC-safe while the daemon writes).
 * WRITES (memory_save / journal_note) are queued to the spool; the daemon —
 * the single writer — embeds and commits them within a sweep (~2s).
 */
import {
  Embedder,
  loadConfig,
  localDate,
  normalizeRepoPath,
  smartSearch,
  Store,
  TABLES,
} from "@lazyobserver/core";
import { queueMemWrite } from "@lazyobserver/daemon/memwrite";

export interface Ctx {
  store: Store;
  embedder: Pick<Embedder, "embedOne">;
}

function fmtDate(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0
    ? new Date(n).toISOString().slice(0, 10)
    : "";
}

function esc(v: string): string {
  return v.replace(/'/g, "");
}

// --------------------------------------------------------------------------
// memory_search — durable codebase knowledge
// --------------------------------------------------------------------------

export interface MemorySearchArgs {
  query: string;
  repo?: string;
  kind?: string;
  k?: number;
  include_superseded?: boolean;
}

export async function memorySearch(
  ctx: Ctx,
  args: MemorySearchArgs,
): Promise<string> {
  const vector = await ctx.embedder.embedOne(args.query);
  const where: string[] = [];
  if (!args.include_superseded) where.push("status = 'active'");
  if (args.repo) where.push(`repo = '${esc(normalizeRepoPath(args.repo))}'`);
  if (args.kind) where.push(`kind = '${esc(args.kind)}'`);

  const { rows, mode } = await smartSearch(ctx.store, TABLES.codebaseMemory, {
    query: args.query,
    vector,
    k: args.k ?? 6,
    where: where.join(" AND ") || undefined,
  });
  if (rows.length === 0) return "No matching memories.";
  const out = rows.map((r, i) => {
    const body = String(r.body ?? "");
    return (
      `${i + 1}. [${r.kind}] ${r.title}  (repo: ${r.repo || "—"}, updated: ${fmtDate(r.updated_at)}, id: ${r.id})\n` +
      (body.length > 700 ? body.slice(0, 700) + " …" : body)
    );
  });
  return `${rows.length} memories (${mode} search):\n\n${out.join("\n\n")}`;
}

// --------------------------------------------------------------------------
// work_recall — past days: journal + actual conversation history
// --------------------------------------------------------------------------

export interface WorkRecallArgs {
  query: string;
  date_from?: string; // YYYY-MM-DD
  date_to?: string;
  k?: number;
}

export async function workRecall(
  ctx: Ctx,
  args: WorkRecallArgs,
): Promise<string> {
  const vector = await ctx.embedder.embedOne(args.query);
  const k = args.k ?? 8;

  const dailyWhere: string[] = [];
  if (args.date_from) dailyWhere.push(`date >= '${esc(args.date_from)}'`);
  if (args.date_to) dailyWhere.push(`date <= '${esc(args.date_to)}'`);
  const daily = await smartSearch(ctx.store, TABLES.dailyMemory, {
    query: args.query,
    vector,
    k,
    where: dailyWhere.join(" AND ") || undefined,
  });

  const msgWhere: string[] = [];
  if (args.date_from)
    msgWhere.push(`ts >= ${Date.parse(args.date_from + "T00:00:00")}`);
  if (args.date_to)
    msgWhere.push(`ts <= ${Date.parse(args.date_to + "T23:59:59")}`);
  const msgs = await smartSearch(ctx.store, TABLES.messages, {
    query: args.query,
    vector,
    k,
    where: msgWhere.join(" AND ") || undefined,
  });

  const parts: string[] = [];
  for (const r of daily.rows) {
    parts.push(
      `[journal ${r.date} ${r.kind}] ${r.title ? r.title + ": " : ""}${String(r.body ?? "").slice(0, 500)}`,
    );
  }
  for (const r of msgs.rows) {
    parts.push(
      `[conversation ${fmtDate(r.ts)} ${r.role} ${String(r.repo ?? "").split("/").pop() ?? ""}] ${String(r.content ?? "").slice(0, 400)}`,
    );
  }
  if (parts.length === 0) return "Nothing found for that query/date range.";
  return `${parts.length} hits (journal: ${daily.rows.length}, conversation: ${msgs.rows.length}):\n\n${parts.join("\n\n")}`;
}

// --------------------------------------------------------------------------
// memory_save — the agent persists an insight mid-session
// --------------------------------------------------------------------------

export interface MemorySaveArgs {
  kind: "decision" | "feature" | "gotcha" | "runbook" | "reference" | "preference";
  title: string;
  body: string;
  repo?: string;
  scope?: "repo" | "workspace" | "global";
  supersedes?: string;
}

export async function memorySave(
  _ctx: Ctx,
  args: MemorySaveArgs,
): Promise<string> {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await queueMemWrite({
    table: TABLES.codebaseMemory,
    row: {
      id,
      repo: args.repo ? normalizeRepoPath(args.repo) : "",
      scope: args.scope ?? "repo",
      kind: args.kind,
      title: args.title,
      body: args.body,
      status: "active",
      supersedes: args.supersedes ?? "",
      created_at: now,
      updated_at: now,
      source_session: process.env.CLAUDE_SESSION_ID ?? "",
    },
  });
  return `Saved memory ${id} (${args.kind}: "${args.title}")${args.supersedes ? `, superseding ${args.supersedes}` : ""}. The daemon commits it within ~2s.`;
}

// --------------------------------------------------------------------------
// journal_note — thought-process breadcrumbs into today's daily memory
// --------------------------------------------------------------------------

export interface JournalNoteArgs {
  text: string;
  title?: string;
}

export async function journalNote(
  _ctx: Ctx,
  args: JournalNoteArgs,
): Promise<string> {
  const cfg = await loadConfig();
  const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await queueMemWrite({
    table: TABLES.dailyMemory,
    row: {
      id,
      date: localDate(),
      kind: "entry",
      workspaces: JSON.stringify(
        cfg.currentWorkspace ? [cfg.currentWorkspace] : [],
      ),
      title: args.title ?? "",
      body: args.text,
      session_id: process.env.CLAUDE_SESSION_ID ?? "",
      created_at: Date.now(),
    },
  });
  return `Journal note ${id} queued for ${localDate()}.`;
}

// --------------------------------------------------------------------------
// tasks_today / task_update — the unified task list, agent-side
// --------------------------------------------------------------------------

export async function tasksToday(ctx: Ctx): Promise<string> {
  const tbl = await ctx.store.table(TABLES.tasks);
  const rows = (await tbl
    .query()
    .where("status != 'done'")
    .limit(200)
    .toArray()) as Record<string, unknown>[];
  if (rows.length === 0)
    return "No open tasks in the store (run `lzo tasks sync` to pull).";
  const lines = rows.map((r) => {
    let due = "";
    try {
      due = (JSON.parse(String(r.description)) as { due?: string }).due ?? "";
    } catch {
      /* legacy row */
    }
    return `- [${r.status}] ${r.source_id}: ${r.title}${r.sprint ? ` (sprint: ${r.sprint})` : ""}${due ? ` (due: ${due})` : ""}${r.branch ? ` — branch ${r.branch}` : ""}`;
  });
  return `${rows.length} open task(s):\n${lines.join("\n")}`;
}

export interface TaskUpdateArgs {
  ref: string; // task id or source_id
  status: "todo" | "in_progress" | "review" | "done" | "blocked";
  comment?: string;
}

/**
 * Update a task locally (via spool). Pushing to ClickUp/GitHub involves the
 * user's credentials — the agent records the transition; `lzo tasks done`
 * performs the authoritative two-way push.
 */
export async function taskUpdate(
  ctx: Ctx,
  args: TaskUpdateArgs,
): Promise<string> {
  const tbl = await ctx.store.table(TABLES.tasks);
  const rows = (await tbl.query().limit(2000).toArray()) as Record<
    string,
    unknown
  >[];
  const hits = rows.filter(
    (r) =>
      String(r.id) === args.ref ||
      String(r.source_id) === args.ref ||
      String(r.id).includes(args.ref),
  );
  if (hits.length !== 1)
    return hits.length === 0
      ? `No task matches "${args.ref}".`
      : `"${args.ref}" is ambiguous (${hits.length} matches).`;
  const r = hits[0];
  await queueMemWrite({
    table: TABLES.tasks,
    row: {
      ...Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== "vector"),
      ),
      status: args.status,
      updated_at: Date.now(),
      synced_at: Number(r.synced_at ?? 0),
    },
  });
  if (args.comment) {
    await journalNote(ctx, {
      title: `task ${r.source_id} -> ${args.status}`,
      text: args.comment,
    });
  }
  return `Task ${r.source_id} -> ${args.status} (local). Push to ${r.source} with: lzo tasks ${args.status === "done" ? "done" : "start"} ${r.source_id}`;
}

// --------------------------------------------------------------------------
// daily_brief — read a day's journal (day doc + entries)
// --------------------------------------------------------------------------

export interface DailyBriefArgs {
  date?: string; // YYYY-MM-DD, default today
}

export async function dailyBrief(
  ctx: Ctx,
  args: DailyBriefArgs,
): Promise<string> {
  const date = args.date ?? localDate();
  const tbl = await ctx.store.table(TABLES.dailyMemory);
  const rows = (await tbl
    .query()
    .where(`date = '${esc(date)}'`)
    .limit(200)
    .toArray()) as Record<string, unknown>[];
  if (rows.length === 0) return `No journal for ${date}.`;

  const dayDocs = rows.filter((r) => r.kind === "day_doc");
  const entries = rows
    .filter((r) => r.kind === "entry")
    .sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const parts: string[] = [`# Journal ${date}`];
  for (const d of dayDocs) parts.push(String(d.body ?? ""));
  if (entries.length > 0) {
    parts.push(
      `## Notes (${entries.length})\n` +
        entries
          .map(
            (e) =>
              `- ${e.title ? `**${e.title}**: ` : ""}${String(e.body ?? "").slice(0, 300)}`,
          )
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}
