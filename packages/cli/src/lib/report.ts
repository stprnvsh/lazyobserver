/**
 * Report assembly — the observability rollup for a day (used by `lzo report`
 * and the web dashboard).
 *
 * Everything is computed from the store: tasks (+ per-task time from
 * task-tagged events and linked-branch sessions), sessions with tokens/cost,
 * activity stats, user-vs-agent contribution split, decisions, and the day
 * document. Renderers: terminal / markdown / self-contained HTML / JSON.
 */
import { Store, TABLES } from "@lazyobserver/core";

import { gatherDayMaterial, type DayMaterial } from "./eod.js";
import { rowToStoredTask, type StoredTask } from "./tasks/sync.js";

export interface DayReport {
  date: string;
  material: DayMaterial;
  tasks: {
    open: StoredTask[];
    done: StoredTask[];
    doneToday: StoredTask[];
    percentDone: number;
    /** minutes attributed per task id (events tagged or branch-matched) */
    minutesByTask: Record<string, number>;
  };
  totals: {
    sessions: number;
    minutes: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    userPrompts: number;
    agentActions: number;
  };
  decisions: {
    context: string;
    choice: string;
    rationale: string;
    proposed_by: string;
    decided_by: string;
  }[];
  dayDoc: { title: string; body: string } | null;
}

export async function assembleReport(
  store: Store,
  date: string,
): Promise<DayReport> {
  const material = await gatherDayMaterial(store, date);

  const taskRows = (await (await store.table(TABLES.tasks))
    .query()
    .limit(5000)
    .toArray()) as Record<string, unknown>[];
  const tasks = taskRows.map(rowToStoredTask);
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  const dayStart = Date.parse(`${date}T00:00:00`);
  const dayEnd = Date.parse(`${date}T23:59:59`);
  const doneToday = done.filter(
    (t) => t.updated_at >= dayStart && t.updated_at <= dayEnd,
  );

  // per-task time: task-tagged events bucketed into 10-minute slices, plus
  // whole sessions whose branch matches a linked task branch
  const events = (await (await store.table(TABLES.events))
    .query()
    .where(`ts >= ${dayStart} AND ts <= ${dayEnd} AND task_id != ''`)
    .limit(20_000)
    .toArray()) as Record<string, unknown>[];
  const sliceSets = new Map<string, Set<number>>();
  for (const e of events) {
    const id = String(e.task_id);
    if (!sliceSets.has(id)) sliceSets.set(id, new Set());
    sliceSets.get(id)!.add(Math.floor(Number(e.ts) / 600_000));
  }
  const minutesByTask: Record<string, number> = {};
  for (const [id, slices] of sliceSets) minutesByTask[id] = slices.size * 10;
  for (const t of tasks) {
    if (minutesByTask[t.id] || !t.branch) continue;
    const matched = material.sessions.filter(
      (s) => s.branch === t.branch && (!t.repo || s.repo === t.repo),
    );
    const mins = matched.reduce((a, s) => a + s.minutes, 0);
    if (mins > 0) minutesByTask[t.id] = mins;
  }

  const userPrompts = material.eventStats["prompt"] ?? 0;
  const agentActions =
    (material.eventStats["tool_call"] ?? 0) +
    (material.eventStats["file_edit"] ?? 0) +
    (material.eventStats["command"] ?? 0);

  const costRows = (await (await store.table(TABLES.sessions))
    .query()
    .where(`ended_at >= ${dayStart} AND started_at <= ${dayEnd}`)
    .limit(500)
    .toArray()) as Record<string, unknown>[];
  const costUsd = costRows.reduce((a, s) => a + Number(s.cost_usd ?? 0), 0);

  const decisions = (
    (await (await store.table(TABLES.decisions))
      .query()
      .where(`date = '${date}'`)
      .limit(100)
      .toArray()) as Record<string, unknown>[]
  ).map((d) => ({
    context: String(d.context ?? ""),
    choice: String(d.choice ?? ""),
    rationale: String(d.rationale ?? ""),
    proposed_by: String(d.proposed_by ?? ""),
    decided_by: String(d.decided_by ?? ""),
  }));

  const dayDocs = (await (await store.table(TABLES.dailyMemory))
    .query()
    .where(`date = '${date}' AND kind = 'day_doc'`)
    .limit(1)
    .toArray()) as Record<string, unknown>[];
  const dayDoc = dayDocs.length
    ? { title: String(dayDocs[0].title), body: String(dayDocs[0].body) }
    : null;

  const total = open.length + done.length;
  return {
    date,
    material,
    tasks: {
      open,
      done,
      doneToday,
      percentDone: total ? Math.round((done.length / total) * 100) : 0,
      minutesByTask,
    },
    totals: {
      sessions: material.sessions.length,
      minutes: material.sessions.reduce((a, s) => a + s.minutes, 0),
      tokensIn: material.sessions.reduce((a, s) => a + s.tokens_in, 0),
      tokensOut: material.sessions.reduce((a, s) => a + s.tokens_out, 0),
      costUsd,
      userPrompts,
      agentActions,
    },
    decisions,
    dayDoc,
  };
}

// --------------------------------------------------------------------------
// renderers
// --------------------------------------------------------------------------

export function renderMarkdown(r: DayReport): string {
  const t = r.totals;
  const lines: string[] = [
    `# Daily report — ${r.date}`,
    "",
    `**Sessions:** ${t.sessions} (${t.minutes} min) · **Tokens:** ${t.tokensIn.toLocaleString()} in / ${t.tokensOut.toLocaleString()} out · **Cost:** $${t.costUsd.toFixed(2)}`,
    `**Contribution:** ${t.userPrompts} user prompt(s) → ${t.agentActions} agent action(s)`,
    "",
    `## Tasks (${r.tasks.percentDone}% of tracked tasks done)`,
  ];
  if (r.tasks.doneToday.length) {
    lines.push(`### Completed today`);
    for (const task of r.tasks.doneToday)
      lines.push(
        `- ✅ ${task.source_id}: ${task.title}${task.pr_url ? ` (PR: ${task.pr_url})` : ""}`,
      );
  }
  if (r.tasks.open.length) {
    lines.push(`### Open (${r.tasks.open.length})`);
    for (const task of r.tasks.open.slice(0, 25)) {
      const mins = r.tasks.minutesByTask[task.id];
      lines.push(
        `- [${task.status}] ${task.source_id}: ${task.title}` +
          `${task.branch ? ` — ${task.branch}` : ""}${mins ? ` — ~${mins}m today` : ""}`,
      );
    }
  }
  if (r.decisions.length) {
    lines.push("", `## Decisions (${r.decisions.length})`);
    for (const d of r.decisions)
      lines.push(
        `- **${d.choice}** — ${d.rationale} _(proposed: ${d.proposed_by}, decided: ${d.decided_by})_`,
      );
  }
  lines.push("", "## Activity");
  for (const [k, v] of Object.entries(r.material.eventStats))
    lines.push(`- ${k}: ${v}`);
  if (r.material.filesEdited.length) {
    lines.push("", `## Files touched (${r.material.filesEdited.length})`);
    for (const f of r.material.filesEdited.slice(0, 30)) lines.push(`- ${f}`);
  }
  if (r.dayDoc) lines.push("", "## Day document", "", r.dayDoc.body);
  return lines.join("\n") + "\n";
}

export function renderHtml(r: DayReport): string {
  const md = renderMarkdown(r);
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const t = r.totals;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>lazyobserver — ${r.date}</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#1a2233;background:#fafbfc}
h1{font-size:1.4rem} .cards{display:flex;gap:12px;flex-wrap:wrap;margin:1rem 0}
.card{background:#fff;border:1px solid #e3e8ee;border-radius:8px;padding:12px 16px;min-width:130px}
.card b{display:block;font-size:1.3rem} .card span{color:#5b6b7f;font-size:.8rem}
pre{white-space:pre-wrap;background:#fff;border:1px solid #e3e8ee;border-radius:8px;padding:16px}
</style></head><body>
<h1>Daily report — ${r.date}</h1>
<div class="cards">
<div class="card"><b>${t.sessions}</b><span>sessions (${t.minutes}m)</span></div>
<div class="card"><b>${r.tasks.doneToday.length}</b><span>tasks done today</span></div>
<div class="card"><b>${r.tasks.percentDone}%</b><span>tracked tasks done</span></div>
<div class="card"><b>${(t.tokensIn + t.tokensOut).toLocaleString()}</b><span>tokens · $${t.costUsd.toFixed(2)}</span></div>
<div class="card"><b>${t.userPrompts} → ${t.agentActions}</b><span>user prompts → agent actions</span></div>
</div>
<pre>${esc(md)}</pre>
</body></html>`;
}
