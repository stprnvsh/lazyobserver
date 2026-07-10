/**
 * Requirements encoded here:
 *  - gatherDayMaterial pulls exactly the requested day: sessions, event
 *    stats, edited files, journal notes, and a capped ordered narrative.
 *  - parseDistillation tolerates fences/prose around the JSON and fills
 *    missing keys safely.
 *  - offlineDistillation produces a real day doc with zero LLM.
 *  - applyDistillation writes ONLY spool files (single-writer invariant).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import {
  applyDistillation,
  gatherDayMaterial,
  offlineDistillation,
  parseDistillation,
} from "../src/lib/eod.js";

let tmp: string;
let store: Store;
const DAY = "2026-07-10";
const T0 = Date.parse(`${DAY}T09:00:00`);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-eod-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  store = await Store.open();
  await store.ensureTables();

  await (await store.table(TABLES.sessions)).add([
    {
      id: "s-1",
      started_at: T0,
      ended_at: T0 + 45 * 60_000,
      repo: "/r/django",
      workspace: "transcality",
      branch: "fix/webhook",
      profile: "work",
      surface: "vscode",
      model: "claude-opus-4-8",
      tokens_in: 1000,
      tokens_out: 400,
      cost_usd: 0.5,
      summary: "",
      vector: new Array(384).fill(0),
    },
    {
      // previous day — must NOT be gathered
      id: "s-old",
      started_at: T0 - 86_400_000,
      ended_at: T0 - 86_000_000,
      repo: "/r/django",
      workspace: "transcality",
      branch: "old",
      profile: "work",
      surface: "cli",
      model: "",
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0,
      summary: "",
      vector: new Array(384).fill(0),
    },
  ]);
  await (await store.table(TABLES.events)).add([
    {
      id: "e-1",
      ts: T0 + 60_000,
      session_id: "s-1",
      surface: "vscode",
      actor: "agent",
      kind: "file_edit",
      repo: "/r/django",
      workspace: "transcality",
      branch: "",
      task_id: "",
      payload: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/r/django/app.py" } }),
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    },
    {
      id: "e-2",
      ts: T0 + 120_000,
      session_id: "s-1",
      surface: "vscode",
      actor: "user",
      kind: "prompt",
      repo: "/r/django",
      workspace: "transcality",
      branch: "",
      task_id: "",
      payload: JSON.stringify({ prompt: "fix it" }),
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    },
  ]);
  await (await store.table(TABLES.messages)).add([
    {
      id: "m-1",
      session_id: "s-1",
      ts: T0 + 90_000,
      role: "user",
      seq: 0,
      content: "the db does not update when the simulation finishes",
      repo: "/r/django",
      profile: "work",
      vector: new Array(384).fill(0),
    },
    {
      id: "m-2",
      session_id: "s-1",
      ts: T0 + 95_000,
      role: "assistant",
      seq: 0,
      content: "the webhook runs without org context so fail-closed RLS hides the row",
      repo: "/r/django",
      profile: "work",
      vector: new Array(384).fill(0),
    },
  ]);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("gatherDayMaterial", () => {
  it("collects exactly the day's material, ordered narrative included", async () => {
    const m = await gatherDayMaterial(store, DAY);
    expect(m.sessions.map((s) => s.id)).toEqual(["s-1"]);
    expect(m.sessions[0].minutes).toBe(45);
    expect(m.eventStats).toMatchObject({ file_edit: 1, prompt: 1 });
    expect(m.filesEdited).toContain("/r/django/app.py");
    expect(m.narrative.map((n) => n.role)).toEqual(["user", "assistant"]);
  });
});

describe("parseDistillation", () => {
  it("tolerates fences and prose around the JSON", () => {
    const raw =
      'Here you go:\n```json\n{"day_doc":{"title":"T","body":"B"},"memory_upserts":[],"decisions":[]}\n```';
    const d = parseDistillation(raw);
    expect(d.day_doc.title).toBe("T");
  });

  it("fills missing keys safely and rejects non-JSON", () => {
    expect(parseDistillation('{"day_doc":{"title":"x"}}').memory_upserts).toEqual([]);
    expect(() => parseDistillation("no json here")).toThrow();
  });
});

describe("offline + apply", () => {
  it("offline distillation builds a real day doc from material", async () => {
    const m = await gatherDayMaterial(store, DAY);
    const d = offlineDistillation(m);
    expect(d.day_doc.body).toContain("Sessions (1)");
    expect(d.day_doc.body).toContain("file_edit: 1");
  });

  it("applyDistillation writes only spool files, never the tables", async () => {
    const memBefore = await (await store.table(TABLES.codebaseMemory)).countRows();
    const res = await applyDistillation(
      {
        day_doc: { title: "T", body: "B" },
        memory_upserts: [
          { kind: "gotcha", title: "g", body: "b", repo: "/r/django" },
        ],
        decisions: [
          {
            context: "c",
            options: ["a", "b"],
            choice: "a",
            rationale: "r",
            proposed_by: "agent",
            decided_by: "user",
          },
        ],
      },
      DAY,
      ["transcality"],
    );
    expect(res.dayDocId).toBe(`day-${DAY}`);
    expect(res.memoryIds).toHaveLength(1);
    expect(res.decisionIds).toHaveLength(1);
    expect(await (await store.table(TABLES.codebaseMemory)).countRows()).toBe(memBefore);

    const spool = (await readdir(path.join(tmp, "spool"))).filter((f) =>
      f.startsWith("mem-"),
    );
    expect(spool.length).toBe(3); // day doc + memory + decision
    const tables = await Promise.all(
      spool.map(async (f) =>
        (JSON.parse(await readFile(path.join(tmp, "spool", f), "utf8")) as { table: string })
          .table,
      ),
    );
    expect(tables.sort()).toEqual(["codebase_memory", "daily_memory", "decisions"]);
  });
});
