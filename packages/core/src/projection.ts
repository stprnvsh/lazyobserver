/**
 * MEMORY.md projection — keeps native Claude Code memory recall working
 * while LanceDB is the canonical memory store.
 *
 * We only ever touch OUR marked block inside a repo's MEMORY.md; everything
 * the user (or the existing auto-memory system) wrote stays byte-identical.
 */
const START = "<!-- lazyobserver:start -->";
const END = "<!-- lazyobserver:end -->";

export interface ProjectedMemory {
  kind: string;
  title: string;
  body: string;
  updated_at?: number;
}

/** Claude Code munges a cwd into a project-dir slug (verified on disk). */
export function repoToSlug(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function renderMemoryBlock(memories: ProjectedMemory[]): string {
  const lines: string[] = [
    START,
    "## lazyobserver memory (generated — do not edit)",
    "",
    "Canonical memory lives in lazyobserver. For deep recall use the MCP tools:",
    "`memory_search` (codebase knowledge), `work_recall` (past days/conversations),",
    "`journal_note` / `memory_save` (write). Top active memories for this repo:",
    "",
  ];
  for (const m of memories.slice(0, 30)) {
    const hook = m.body.replace(/\s+/g, " ").slice(0, 110);
    lines.push(`- **[${m.kind}] ${m.title}** — ${hook}${m.body.length > 110 ? "…" : ""}`);
  }
  if (memories.length === 0) lines.push("- (none yet)");
  lines.push(END);
  return lines.join("\n");
}

/**
 * Replace our marked block in `existing` (or append it). Content outside the
 * markers is preserved byte-for-byte. Idempotent.
 */
export function upsertMemoryBlock(existing: string, block: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end > start) {
    return (
      existing.slice(0, start) + block + existing.slice(end + END.length)
    );
  }
  const sep = existing.length === 0 || existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
  return existing + sep + block + "\n";
}
