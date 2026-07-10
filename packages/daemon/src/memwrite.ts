/**
 * Memory-write spool protocol.
 *
 * Anything OUTSIDE the daemon (MCP server, `lzo import`, `lzo eod`) that
 * wants to WRITE memory drops a `mem-*.json` file into the spool instead of
 * touching LanceDB — the daemon is the single writer. Reads stay direct
 * (MVCC-safe).
 *
 * File shape: { table: "codebase_memory"|"daily_memory"|"decisions", row: {...} }
 * The daemon embeds the row's text at ingest and honors `supersedes`
 * (flips the referenced record to status=superseded).
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { paths, TABLES } from "@lazyobserver/core";

export type MemTable =
  | typeof TABLES.codebaseMemory
  | typeof TABLES.dailyMemory
  | typeof TABLES.decisions
  | typeof TABLES.tasks;

export interface MemWrite {
  table: MemTable;
  row: Record<string, unknown>;
}

export function isMemFile(name: string): boolean {
  return name.startsWith("mem-") && name.endsWith(".json");
}

/** Queue a memory write for the daemon. Atomic (tmp -> rename). */
export async function queueMemWrite(write: MemWrite): Promise<string> {
  const dir = paths.spool();
  await mkdir(dir, { recursive: true });
  const name = `mem-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(write), "utf8");
  await rename(tmp, path.join(dir, name));
  return name;
}

/** Text used for the row's embedding, per table. */
export function embeddingText(table: MemTable, row: Record<string, unknown>): string {
  if (table === TABLES.codebaseMemory || table === TABLES.dailyMemory) {
    return `${String(row.title ?? "")}\n${String(row.body ?? "")}`.trim();
  }
  if (table === TABLES.tasks) {
    return `${String(row.title ?? "")}\n${String(row.description ?? "")}`.trim();
  }
  // decisions
  return `${String(row.context ?? "")}\n${String(row.choice ?? "")}\n${String(row.rationale ?? "")}`.trim();
}
