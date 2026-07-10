/**
 * Requirements encoded here:
 *  - ensureTables() creates the full table set idempotently (init + upgrades).
 *  - Vector search over memory records returns semantically closest rows
 *    (vectors are the contract; the real model is covered in embeddings.test).
 *  - Full-text (BM25) search finds EXACT identifiers — our work is full of
 *    ids like "GS_10253384528" / "SUMOK8JobFailed" that semantic search
 *    alone would miss.
 *  - Hybrid search (FTS + vector + RRF rerank) unions both worlds.
 *  - Scalar filters (repo/status) compose with search — memory recall is
 *    always scoped (e.g. active records for one repo).
 *  - Inserts after index creation become searchable after optimize() —
 *    the daemon's maintenance loop depends on this behavior.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "../src/store/index.js";
import { EMBEDDING_DIMENSIONS } from "../src/embeddings.js";

let tmp: string;
let store: Store;

/** Deterministic fake vectors: unit vectors with tiny off-axis noise. */
function axisVec(axis: number, lean = 0): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = 1;
  if (lean >= 0 && lean !== axis) {
    v[axis] = 0.9;
    v[lean] = 0.436; // keeps ||v|| ~= 1
  }
  return v;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-store-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  store = await Store.open();
  await store.ensureTables();
});

afterAll(async () => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("table management", () => {
  it("creates all tables and is idempotent", async () => {
    const names = await store.tableNames();
    for (const t of Object.values(TABLES)) expect(names).toContain(t);
    await store.ensureTables(); // second run must not throw or duplicate
    expect((await store.tableNames()).length).toBe(names.length);
  });
});

describe("codebase memory retrieval", () => {
  beforeAll(async () => {
    const tbl = await store.table(TABLES.codebaseMemory);
    await tbl.add([
      {
        id: "m1",
        repo: "/r/django",
        scope: "repo",
        kind: "gotcha",
        title: "WAUT signal plan mismatch",
        body: "SUMO fails with No initial signal plan loaded for tls GS_10253384528 because the additional file uses unprefixed ids",
        status: "active",
        supersedes: "",
        created_at: 1,
        updated_at: 1,
        source_session: "s1",
        vector: axisVec(0),
      },
      {
        id: "m2",
        repo: "/r/django",
        scope: "repo",
        kind: "decision",
        title: "webhook RLS org context",
        body: "the completion webhook must set the RLS org context from the payload organisation_id",
        status: "active",
        supersedes: "",
        created_at: 2,
        updated_at: 2,
        source_session: "s2",
        vector: axisVec(5),
      },
      {
        id: "m3",
        repo: "/r/frontend",
        scope: "repo",
        kind: "gotcha",
        title: "SSO nonce",
        body: "cognito always emits a nonce so openid-client must verify it",
        status: "superseded",
        supersedes: "",
        created_at: 3,
        updated_at: 3,
        source_session: "s3",
        vector: axisVec(10),
      },
    ]);
    await store.createFtsIndexes();
  });

  it("vector search returns the semantically closest record first", async () => {
    const tbl = await store.table(TABLES.codebaseMemory);
    const hits = await tbl
      .query()
      .nearestTo(axisVec(0, 5)) // near m1, leaning m2
      .limit(2)
      .toArray();
    expect(hits[0].id).toBe("m1");
    expect(hits[1].id).toBe("m2");
  });

  it("FTS finds exact identifiers like GS_10253384528", async () => {
    const tbl = await store.table(TABLES.codebaseMemory);
    const hits = await tbl
      .query()
      .fullTextSearch("GS_10253384528")
      .limit(5)
      .toArray();
    expect(hits.map((h) => h.id)).toContain("m1");
  });

  it("hybrid search (FTS + vector + RRF) unions keyword and semantic hits", async () => {
    const hits = await store.hybridSearch(TABLES.codebaseMemory, {
      query: "organisation_id webhook",
      vector: axisVec(0),
      k: 3,
    });
    const ids = hits.map((h) => h.id as string);
    expect(ids).toContain("m2"); // keyword match
    expect(ids).toContain("m1"); // vector match
  });

  it("scalar filters compose with search (repo + active only)", async () => {
    const tbl = await store.table(TABLES.codebaseMemory);
    const hits = await tbl
      .query()
      .where("repo = '/r/django' AND status = 'active'")
      .toArray();
    expect(hits.map((h) => h.id).sort()).toEqual(["m1", "m2"]);
  });

  it("rows added after index creation become searchable after optimize()", async () => {
    const tbl = await store.table(TABLES.codebaseMemory);
    await tbl.add([
      {
        id: "m4",
        repo: "/r/django",
        scope: "repo",
        kind: "runbook",
        title: "purge command",
        body: "purge_deleted_projects erases soft-deleted rows XKCD9999TOKEN",
        status: "active",
        supersedes: "",
        created_at: 4,
        updated_at: 4,
        source_session: "s4",
        vector: axisVec(20),
      },
    ]);
    await store.optimizeAll();
    const hits = await tbl
      .query()
      .fullTextSearch("XKCD9999TOKEN")
      .limit(5)
      .toArray();
    expect(hits.map((h) => h.id)).toContain("m4");
  });
});

describe("events table (granular trace)", () => {
  it("stores and filters granular events by session and kind", async () => {
    const tbl = await store.table(TABLES.events);
    await tbl.add([
      {
        id: "e1",
        ts: 1000,
        session_id: "sess-1",
        surface: "vscode",
        actor: "user",
        kind: "prompt",
        repo: "/r/django",
        workspace: "transcality",
        branch: "main",
        task_id: "",
        payload: JSON.stringify({ text: "fix the webhook" }),
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      },
      {
        id: "e2",
        ts: 2000,
        session_id: "sess-1",
        surface: "vscode",
        actor: "agent",
        kind: "tool_call",
        repo: "/r/django",
        workspace: "transcality",
        branch: "main",
        task_id: "",
        payload: JSON.stringify({ tool: "Edit" }),
        tokens_in: 120,
        tokens_out: 30,
        cost_usd: 0.001,
      },
    ]);
    const agentEvents = await tbl
      .query()
      .where("session_id = 'sess-1' AND actor = 'agent'")
      .toArray();
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].kind).toBe("tool_call");
  });
});
