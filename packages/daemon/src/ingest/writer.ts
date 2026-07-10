/**
 * The single writer. Everything that lands in LanceDB goes through here —
 * batched, idempotent (mergeInsert on `id`), with in-memory session
 * aggregates rolled up into the `sessions` table.
 *
 * Idempotency matters because capture is at-least-once by design: a spool
 * file is only deleted after a successful commit, and hook + transcript
 * overlap for prompts. Deterministic ids make replays harmless.
 */
import { Store, TABLES, type TableName } from "@lazyobserver/core";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface EventRow {
  id: string;
  ts: number;
  session_id: string;
  surface: string;
  actor: string;
  kind: string;
  repo: string;
  workspace: string;
  branch: string;
  task_id: string;
  payload: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  ts: number;
  role: string;
  seq: number;
  content: string;
  repo: string;
  profile: string;
  vector: number[];
}

export interface SessionAggregate {
  id: string;
  started_at: number;
  ended_at: number;
  repo: string;
  workspace: string;
  branch: string;
  profile: string;
  surface: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

const ZERO_VECTOR_TABLES: TableName[] = []; // events/sessions handled explicitly

export class Writer {
  private eventQueue: EventRow[] = [];
  private messageQueue: MessageRow[] = [];
  private sessions = new Map<string, SessionAggregate>();
  private dirtySessions = new Set<string>();
  private rowsSinceOptimize = 0;
  readonly counters = {
    events: 0,
    messages: 0,
    sessions: 0,
    flushes: 0,
    memoryWrites: 0,
  };

  constructor(
    private readonly store: Store,
    private readonly embed: EmbedFn,
  ) {}

  queueEvent(row: EventRow): void {
    this.eventQueue.push(row);
  }

  /** vector computed at flush (batch-embedded) */
  queueMessage(row: Omit<MessageRow, "vector">): void {
    this.messageQueue.push({ ...row, vector: [] });
  }

  touchSession(patch: Partial<SessionAggregate> & { id: string }): void {
    const existing: SessionAggregate = this.sessions.get(patch.id) ?? {
      id: patch.id,
      started_at: patch.started_at ?? Date.now(),
      ended_at: patch.ended_at ?? Date.now(),
      repo: "",
      workspace: "",
      branch: "",
      profile: "",
      surface: "",
      model: "",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
    if (patch.started_at)
      existing.started_at = Math.min(existing.started_at, patch.started_at);
    if (patch.ended_at)
      existing.ended_at = Math.max(existing.ended_at, patch.ended_at);
    for (const key of [
      "repo",
      "workspace",
      "branch",
      "profile",
      "surface",
      "model",
    ] as const) {
      const v = patch[key];
      if (v) existing[key] = v;
    }
    existing.tokens_in += patch.tokens_in ?? 0;
    existing.tokens_out += patch.tokens_out ?? 0;
    existing.cost_usd += patch.cost_usd ?? 0;
    this.sessions.set(patch.id, existing);
    this.dirtySessions.add(patch.id);
  }

  get pending(): number {
    return (
      this.eventQueue.length + this.messageQueue.length + this.dirtySessions.size
    );
  }

  /** Commit all queued rows. Called on a timer and on shutdown. */
  async flush(): Promise<void> {
    if (this.pending === 0) return;

    if (this.eventQueue.length > 0) {
      const rows = this.eventQueue.splice(0);
      const tbl = await this.store.table(TABLES.events);
      await tbl
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows as unknown as Record<string, unknown>[]);
      this.counters.events += rows.length;
      this.rowsSinceOptimize += rows.length;
    }

    if (this.messageQueue.length > 0) {
      const rows = this.messageQueue.splice(0);
      const vectors = await this.embed(rows.map((r) => r.content));
      rows.forEach((r, i) => (r.vector = vectors[i]));
      const tbl = await this.store.table(TABLES.messages);
      await tbl
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows as unknown as Record<string, unknown>[]);
      this.counters.messages += rows.length;
      this.rowsSinceOptimize += rows.length;
    }

    if (this.dirtySessions.size > 0) {
      const rows = [...this.dirtySessions].map((id) => {
        const s = this.sessions.get(id)!;
        return { ...s, summary: "", vector: new Array(384).fill(0) };
      });
      this.dirtySessions.clear();
      const tbl = await this.store.table(TABLES.sessions);
      await tbl
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows as unknown as Record<string, unknown>[]);
      this.counters.sessions += rows.length;
    }

    this.counters.flushes++;
    void ZERO_VECTOR_TABLES;
  }

  /** Fold fresh rows into FTS/vector indexes; cheap when nothing changed. */
  async maintain(): Promise<{ optimized: boolean }> {
    if (this.rowsSinceOptimize === 0) return { optimized: false };
    this.rowsSinceOptimize = 0;
    await this.store.optimizeAll();
    return { optimized: true };
  }

  /**
   * Upsert one memory-plane row (codebase_memory / daily_memory / decisions):
   * embeds the text, mergeInserts by id, and — when the row supersedes an
   * older record — flips that record's status. Low-volume, so not batched.
   */
  async upsertMemoryRow(
    table: TableName,
    row: Record<string, unknown>,
    embedText: string,
  ): Promise<void> {
    const [vector] = await this.embed([embedText || String(row.id)]);
    const tbl = await this.store.table(table);
    await tbl
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([{ ...row, vector }] as unknown as Record<string, unknown>[]);
    this.rowsSinceOptimize++;

    const supersedes = String(row.supersedes ?? "");
    if (supersedes && table === TABLES.codebaseMemory) {
      // update() avoids round-tripping the stored vector (Arrow proxies
      // don't survive a read->mergeInsert cycle)
      await tbl.update({
        where: `id = '${supersedes.replace(/'/g, "")}'`,
        values: { status: "superseded", updated_at: Date.now() },
      });
    }
    this.counters.memoryWrites++;
  }
}
