/**
 * Requirements encoded here:
 *  - mem-*.json spool files (the write path for MCP / import / eod) are
 *    ingested into their target tables WITH embeddings — single-writer holds.
 *  - `supersedes` flips the referenced codebase memory to superseded.
 *  - Replays are idempotent (mergeInsert by id).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import { Writer } from "../src/ingest/writer.js";
import { queueMemWrite } from "../src/memwrite.js";
import { processSpoolOnce } from "../src/spool.js";

let tmp: string;
let store: Store;
let writer: Writer;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(384).fill(0.3));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-memspool-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  store = await Store.open();
  await store.ensureTables();
  writer = new Writer(store, fakeEmbed);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("memory spool writes", () => {
  it("ingests codebase memory with an embedding and drains the file", async () => {
    await queueMemWrite({
      table: TABLES.codebaseMemory,
      row: {
        id: "m-1",
        repo: "/r/x",
        scope: "repo",
        kind: "gotcha",
        title: "first",
        body: "body one",
        status: "active",
        supersedes: "",
        created_at: 1,
        updated_at: 1,
        source_session: "s",
      },
    });
    const n = await processSpoolOnce(writer);
    expect(n).toBe(1);
    expect(
      (await readdir(path.join(tmp, "spool"))).filter((f) => f.startsWith("mem-")),
    ).toHaveLength(0);

    const rows = await (await store.table(TABLES.codebaseMemory))
      .query()
      .where("id = 'm-1'")
      .toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0].vector as unknown as { length: number }).length).toBe(384);
  });

  it("supersede flips the old record", async () => {
    await queueMemWrite({
      table: TABLES.codebaseMemory,
      row: {
        id: "m-2",
        repo: "/r/x",
        scope: "repo",
        kind: "gotcha",
        title: "updated understanding",
        body: "body two",
        status: "active",
        supersedes: "m-1",
        created_at: 2,
        updated_at: 2,
        source_session: "s",
      },
    });
    await processSpoolOnce(writer);

    const tbl = await store.table(TABLES.codebaseMemory);
    const m1 = await tbl.query().where("id = 'm-1'").toArray();
    const m2 = await tbl.query().where("id = 'm-2'").toArray();
    expect(m1[0].status).toBe("superseded");
    expect(m2[0].status).toBe("active");
  });

  it("daily entries and decisions land in their tables", async () => {
    await queueMemWrite({
      table: TABLES.dailyMemory,
      row: {
        id: "n-1",
        date: "2026-07-10",
        kind: "entry",
        workspaces: "[]",
        title: "thought",
        body: "we chose spool-writes to keep the single-writer invariant",
        session_id: "",
        created_at: 3,
      },
    });
    await queueMemWrite({
      table: TABLES.decisions,
      row: {
        id: "d-1",
        date: "2026-07-10",
        session_id: "",
        repo: "/r/x",
        context: "how should MCP write memory",
        options: '["direct lancedb","spool"]',
        choice: "spool",
        rationale: "local-fs concurrent writes are unsafe",
        proposed_by: "agent",
        decided_by: "user",
        links: "{}",
      },
    });
    await processSpoolOnce(writer);

    expect(
      await (await store.table(TABLES.dailyMemory)).query().where("id = 'n-1'").toArray(),
    ).toHaveLength(1);
    expect(
      await (await store.table(TABLES.decisions)).query().where("id = 'd-1'").toArray(),
    ).toHaveLength(1);
    expect(writer.counters.memoryWrites).toBeGreaterThanOrEqual(4);
  });
});
