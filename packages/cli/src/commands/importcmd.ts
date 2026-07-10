/**
 * `lzo import claude-memory` — one-time migration of the existing Claude
 * auto-memory markdown files into lazyobserver's codebase memory.
 *
 * Scans every profile's `<configDir>/projects/<slug>/memory/*.md`, maps the
 * frontmatter (type -> kind), resolves the repo by matching the project slug
 * against registered workspace repos, and queues spool writes (idempotent —
 * ids derive from file paths, so re-imports update rather than duplicate).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { loadConfig, repoToSlug } from "@lazyobserver/core";
import { queueMemWrite } from "@lazyobserver/daemon/memwrite";

import { mapKind, parseMemoryFile } from "../lib/frontmatter.js";
import { info, ok, warn } from "../ui.js";

export async function importClaudeMemory(): Promise<void> {
  const cfg = await loadConfig();
  // slug -> repo path, for every registered repo across workspaces
  const slugToRepo = new Map<string, string>();
  for (const ws of cfg.workspaces) {
    for (const repo of ws.repos) slugToRepo.set(repoToSlug(repo), repo);
  }

  let queued = 0;
  let skipped = 0;
  for (const profile of cfg.profiles) {
    const projectsDir = path.join(profile.claudeConfigDir, "projects");
    let projectSlugs: string[];
    try {
      projectSlugs = await readdir(projectsDir);
    } catch {
      continue;
    }
    for (const slug of projectSlugs) {
      const memDir = path.join(projectsDir, slug, "memory");
      try {
        if (!(await stat(memDir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const repo = slugToRepo.get(slug) ?? "";
      for (const file of await readdir(memDir)) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        const full = path.join(memDir, file);
        try {
          const parsed = parseMemoryFile(await readFile(full, "utf8"));
          if (!parsed.body) {
            skipped++;
            continue;
          }
          const mtime = (await stat(full)).mtimeMs;
          const id = `import-${createHash("sha1").update(full).digest("hex").slice(0, 16)}`;
          await queueMemWrite({
            table: "codebase_memory",
            row: {
              id,
              repo,
              scope: repo ? "repo" : "global",
              kind: mapKind(parsed.type),
              title: parsed.description || parsed.name || file.replace(/\.md$/, ""),
              body: parsed.body,
              status: "active",
              supersedes: "",
              created_at: mtime,
              updated_at: mtime,
              source_session: `import:${full}`,
            },
          });
          queued++;
        } catch (err) {
          warn(`skipping ${full}: ${(err as Error).message}`);
          skipped++;
        }
      }
    }
  }

  ok(`queued ${queued} memories for import${skipped ? ` (${skipped} skipped)` : ""}`);
  info("the daemon embeds and commits them within a couple of seconds");
  info("re-running is safe — ids derive from file paths (update, not duplicate)");
}
