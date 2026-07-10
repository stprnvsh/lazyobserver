/**
 * `lzo eod` — end-of-day: distill the day's captured work into the two
 * memory planes, then refresh MEMORY.md projections.
 *
 *   1. gather   — day material from the store (reads)
 *   2. distill  — `claude -p` on your own account (or --offline mechanical)
 *   3. apply    — day doc + memory upserts + decisions via the spool
 *   4. project  — per-repo MEMORY.md marked blocks
 *   5. export   — the day doc as markdown into ~/.lazyobserver/exports
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadConfig,
  localDate,
  paths,
  renderMemoryBlock,
  repoToSlug,
  Store,
  TABLES,
  upsertMemoryBlock,
  type ProjectedMemory,
} from "@lazyobserver/core";

import {
  applyDistillation,
  buildDistillPrompt,
  claudeRunner,
  gatherDayMaterial,
  offlineDistillation,
  parseDistillation,
  waitForSpoolDrain,
  type DistillRunner,
} from "../lib/eod.js";
import { fail, heading, info, ok, warn } from "../ui.js";

export interface EodOptions {
  date?: string;
  offline?: boolean;
  runner?: DistillRunner; // injectable for tests
}

export async function projectMemoryMd(store: Store): Promise<string[]> {
  const cfg = await loadConfig();
  const mem = await store.table(TABLES.codebaseMemory);
  const written: string[] = [];
  const repos = new Set<string>(cfg.workspaces.flatMap((w) => w.repos));
  for (const repo of repos) {
    const rows = (
      (await mem
        .query()
        .where(`repo = '${repo.replace(/'/g, "")}' AND status = 'active'`)
        .limit(300)
        .toArray()) as unknown as (ProjectedMemory & { updated_at: number })[]
    ).sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    if (rows.length === 0) continue;

    const memoryDir = path.join(
      os.homedir(),
      ".claude",
      "projects",
      repoToSlug(repo),
      "memory",
    );
    const memoryMd = path.join(memoryDir, "MEMORY.md");
    let existing = "";
    try {
      existing = await readFile(memoryMd, "utf8");
    } catch {
      /* new file */
    }
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      memoryMd,
      upsertMemoryBlock(existing, renderMemoryBlock(rows)),
      "utf8",
    );
    written.push(memoryMd);
  }
  return written;
}

export async function eodCommand(opts: EodOptions): Promise<void> {
  const date = opts.date ?? localDate();
  const store = await Store.open();

  heading(`eod — ${date}`);
  const material = await gatherDayMaterial(store, date);
  info(
    `material: ${material.sessions.length} session(s), ` +
      `${Object.values(material.eventStats).reduce((a, b) => a + b, 0)} events, ` +
      `${material.narrative.length} message chunks, ${material.notes.length} notes`,
  );
  if (material.sessions.length === 0 && material.narrative.length === 0) {
    warn("nothing captured for this day — nothing to distill");
    return;
  }

  let distillation;
  if (opts.offline) {
    distillation = offlineDistillation(material);
    info("offline distillation (mechanical day doc, no LLM)");
  } else {
    try {
      const runner = opts.runner ?? claudeRunner;
      info("distilling via claude -p (your account) ...");
      distillation = parseDistillation(await runner(buildDistillPrompt(material)));
      ok(
        `distilled: day doc + ${distillation.memory_upserts.length} memory upsert(s) + ${distillation.decisions.length} decision(s)`,
      );
    } catch (err) {
      warn(`distiller failed (${(err as Error).message}) — falling back to offline`);
      distillation = offlineDistillation(material);
    }
  }

  const cfg = await loadConfig();
  const workspaces = [
    ...new Set(
      material.sessions.flatMap((s) => s.workspace.split(",")).filter(Boolean),
    ),
  ];
  const applied = await applyDistillation(
    distillation,
    date,
    workspaces.length ? workspaces : cfg.currentWorkspace ? [cfg.currentWorkspace] : [],
  );
  ok(
    `queued: ${applied.dayDocId} + ${applied.memoryIds.length} memories + ${applied.decisionIds.length} decisions`,
  );

  if (await waitForSpoolDrain()) ok("daemon committed the writes");
  else warn("daemon didn't drain the spool in time — is it running? (lzo daemon status)");

  const projected = await projectMemoryMd(store);
  if (projected.length > 0) ok(`MEMORY.md projected for ${projected.length} repo(s)`);

  await mkdir(paths.exports(), { recursive: true });
  const exportFile = path.join(paths.exports(), `day-${date}.md`);
  await writeFile(
    exportFile,
    `# ${distillation.day_doc.title}\n\n${distillation.day_doc.body}\n`,
    "utf8",
  );
  ok(`day doc exported: ${exportFile}`);

  if (!opts.offline && distillation.memory_upserts.length === 0) {
    info("(no durable memory upserts today — that can be correct)");
  }
  void fail;
}
