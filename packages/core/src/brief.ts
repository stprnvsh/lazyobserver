/**
 * SessionStart brief — the compact context block injected into every new
 * Claude Code session (via a SessionStart hook that prints to stdout).
 *
 * Fast by construction: filter-only queries (no embedding, no LLM), small
 * result sets, hard character cap. Content: the latest day-doc summary,
 * recent journal notes, and this repo's top active memories, plus a pointer
 * to the MCP tools for deeper recall.
 */
import { normalizeRepoPath } from "./config.js";
import { localDate } from "./store/search.js";
import { Store, TABLES } from "./store/index.js";

const MAX_CHARS = 1800;

export async function buildSessionStartBrief(
  store: Store,
  repoPath: string | undefined,
): Promise<string> {
  const parts: string[] = [];

  // latest day document (yesterday's compiled journal, or today's if present)
  const daily = await store.table(TABLES.dailyMemory);
  const dayDocs = (
    (await daily.query().where("kind = 'day_doc'").limit(500).toArray()) as {
      date: string;
      body: string;
    }[]
  ).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (dayDocs.length > 0) {
    const d = dayDocs[0];
    parts.push(
      `Last day doc (${d.date}): ${String(d.body).replace(/\s+/g, " ").slice(0, 450)}`,
    );
  }

  // today's journal notes so far
  const todayEntries = (await daily
    .query()
    .where(`date = '${localDate()}' AND kind = 'entry'`)
    .limit(50)
    .toArray()) as { title: string; body: string }[];
  if (todayEntries.length > 0) {
    parts.push(
      `Today so far (${todayEntries.length} notes): ` +
        todayEntries
          .slice(-3)
          .map((e) => (e.title ? e.title : String(e.body).slice(0, 80)))
          .join(" · "),
    );
  }

  // this repo's top active memories
  if (repoPath) {
    const repo = normalizeRepoPath(repoPath);
    const mem = await store.table(TABLES.codebaseMemory);
    const rows = (
      (await mem
        .query()
        .where(`repo = '${repo.replace(/'/g, "")}' AND status = 'active'`)
        .limit(200)
        .toArray()) as { kind: string; title: string; updated_at: number }[]
    ).sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    if (rows.length > 0) {
      parts.push(
        `Repo memory (${rows.length} active): ` +
          rows
            .slice(0, 6)
            .map((r) => `[${r.kind}] ${r.title}`)
            .join(" · "),
      );
    }
  }

  if (parts.length === 0) return "";

  const brief =
    "lazyobserver context:\n" +
    parts.map((p) => `- ${p}`).join("\n") +
    "\n- Deeper recall: MCP tools memory_search / work_recall / daily_brief. Save insights with memory_save, thought process with journal_note.";
  return brief.length > MAX_CHARS ? brief.slice(0, MAX_CHARS) + "…" : brief;
}
