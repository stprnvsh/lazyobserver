/**
 * The lazyobserver store — one embedded LanceDB at $LAZYOBSERVER_HOME/db.
 *
 * WRITE DISCIPLINE: LanceDB on a local filesystem is NOT safe for concurrent
 * writers (verified upstream). Reads are MVCC-safe at any time. In M1 the CLI
 * writes directly (single process); from M2 on, the daemon is the ONLY
 * writer and everything else reads or goes through its socket.
 *
 * FTS NOTE: rows added after index creation only join the BM25 index when
 * `optimize()` runs — `optimizeAll()` is the daemon's maintenance hook.
 */
import * as lancedb from "@lancedb/lancedb";

import { paths } from "../paths.js";
import {
  FTS_COLUMNS,
  TABLE_SCHEMAS,
  TABLES,
  type TableName,
} from "./schemas.js";

export { TABLES, type TableName } from "./schemas.js";

export interface HybridSearchOptions {
  /** keyword query (BM25) */
  query: string;
  /** semantic query vector (from Embedder) */
  vector: number[];
  k?: number;
  /** optional SQL filter, e.g. "repo = '/x' AND status = 'active'" */
  where?: string;
}

export class Store {
  private constructor(
    readonly db: lancedb.Connection,
    readonly dir: string,
  ) {}

  static async open(dir: string = paths.db()): Promise<Store> {
    const db = await lancedb.connect(dir);
    return new Store(db, dir);
  }

  async tableNames(): Promise<string[]> {
    return this.db.tableNames();
  }

  /** Create every table that doesn't exist yet. Idempotent. */
  async ensureTables(): Promise<void> {
    const existing = new Set(await this.db.tableNames());
    for (const name of Object.values(TABLES)) {
      if (!existing.has(name)) {
        await this.db.createEmptyTable(name, TABLE_SCHEMAS[name]);
      }
    }
  }

  async table(name: TableName): Promise<lancedb.Table> {
    return this.db.openTable(name);
  }

  /**
   * Create BM25 indexes on all configured text columns. Safe to re-run
   * (`replace: true`); call after first data lands and from `init`.
   */
  async createFtsIndexes(): Promise<void> {
    for (const [tableName, columns] of Object.entries(FTS_COLUMNS)) {
      const tbl = await this.db.openTable(tableName);
      for (const col of columns ?? []) {
        await tbl.createIndex(col, {
          config: lancedb.Index.fts(),
          replace: true,
        });
      }
    }
  }

  /** Fold newly-added rows into indexes; prune old versions. Daemon hook. */
  async optimizeAll(): Promise<void> {
    for (const name of await this.db.tableNames()) {
      const tbl = await this.db.openTable(name);
      await tbl.optimize();
    }
  }

  /**
   * Hybrid retrieval: BM25 + vector, fused with reciprocal-rank fusion.
   * This is the recall primitive both memory planes use — semantic phrasing
   * AND exact identifiers (error codes, tls ids, function names) both hit.
   */
  async hybridSearch(
    tableName: TableName,
    opts: HybridSearchOptions,
  ): Promise<Record<string, unknown>[]> {
    const tbl = await this.db.openTable(tableName);
    const reranker = await lancedb.rerankers.RRFReranker.create();
    let q = tbl
      .query()
      .fullTextSearch(opts.query)
      .nearestTo(opts.vector)
      .rerank(reranker)
      .limit(opts.k ?? 10);
    if (opts.where) q = q.where(opts.where);
    return (await q.toArray()) as Record<string, unknown>[];
  }
}
