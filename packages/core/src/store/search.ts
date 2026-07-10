/**
 * smartSearch — the retrieval primitive every consumer (MCP tools, `lzo ask`,
 * the brief) uses.
 *
 * Hybrid (BM25 + vector + RRF) when the FTS index exists; degrades to
 * vector-only when it doesn't yet (fresh install — the daemon creates FTS
 * indexes on its first optimize pass). Vector search covers unindexed rows
 * by brute force, so brand-new records are always findable; BM25 joins in
 * within one maintenance cycle.
 */
import * as lancedb from "@lancedb/lancedb";

import type { Store } from "./index.js";
import type { TableName } from "./schemas.js";

export interface SmartSearchOptions {
  query: string;
  vector: number[];
  k?: number;
  where?: string;
}

export interface SmartSearchResult {
  rows: Record<string, unknown>[];
  mode: "hybrid" | "vector";
}

export async function smartSearch(
  store: Store,
  tableName: TableName,
  opts: SmartSearchOptions,
): Promise<SmartSearchResult> {
  const tbl = await store.table(tableName);
  const k = opts.k ?? 10;

  try {
    const reranker = await lancedb.rerankers.RRFReranker.create();
    let q = tbl
      .query()
      .fullTextSearch(opts.query)
      .nearestTo(opts.vector)
      .rerank(reranker)
      .limit(k);
    if (opts.where) q = q.where(opts.where);
    return {
      rows: (await q.toArray()) as Record<string, unknown>[],
      mode: "hybrid",
    };
  } catch {
    // no FTS index yet (or FTS query failure) — vector-only fallback
    let q = tbl.query().nearestTo(opts.vector).limit(k);
    if (opts.where) q = q.where(opts.where);
    return {
      rows: (await q.toArray()) as Record<string, unknown>[],
      mode: "vector",
    };
  }
}

/** Local YYYY-MM-DD (the user's timezone, not UTC). */
export function localDate(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA");
}
