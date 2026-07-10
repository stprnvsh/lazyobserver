/**
 * Requirements encoded here:
 *  - memory_search returns scoped, active-only results with vector fallback
 *    (fresh installs have no FTS index yet — search must still work).
 *  - work_recall spans journal AND conversation history with date filters.
 *  - memory_save / journal_note NEVER touch LanceDB directly — they queue
 *    spool files (single-writer invariant).
 *  - daily_brief renders a day's doc + notes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import {
  dailyBrief,
  journalNote,
  memorySave,
  memorySearch,
  workRecall,
  type Ctx,
} from "../src/handlers.js";

let tmp: string;
let store: Store;
let ctx: Ctx;

/** fake embedder: axis vectors keyed by known phrases */
const AXES: Record<string, number> = {
  webhook: 0,
  signal: 7,
};
function vecFor(text: string): number[] {
  const v = new Array(384).fill(0.001);
  for (const [word, axis] of Object.entries(AXES)) {
    if (text.toLowerCase().includes(word)) v[axis] = 1;
  }
  return v;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-mcp-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  store = await Store.open();
  await store.ensureTables();
  ctx = { store, embedder: { embedOne: async (t: string) => vecFor(t) } };

  await (await store.table(TABLES.codebaseMemory)).add([
    {
      id: "cm-1",
      repo: "/r/django",
      scope: "repo",
      kind: "decision",
      title: "webhook RLS org context",
      body: "the completion webhook sets the RLS org context from organisation_id",
      status: "active",
      supersedes: "",
      created_at: 1,
      updated_at: 1,
      source_session: "s",
      vector: vecFor("webhook"),
    },
    {
      id: "cm-2",
      repo: "/r/django",
      scope: "repo",
      kind: "gotcha",
      title: "old superseded note",
      body: "outdated webhook behavior",
      status: "superseded",
      supersedes: "",
      created_at: 0,
      updated_at: 0,
      source_session: "s",
      vector: vecFor("webhook"),
    },
  ]);
  await (await store.table(TABLES.dailyMemory)).add([
    {
      id: "day-2026-07-09",
      date: "2026-07-09",
      kind: "day_doc",
      workspaces: '["transcality"]',
      title: "Fixed the webhook",
      body: "root-caused the RLS webhook drop; user decided the fallback policy",
      session_id: "",
      created_at: 1,
      vector: vecFor("webhook"),
    },
    {
      id: "note-1",
      date: "2026-07-09",
      kind: "entry",
      workspaces: "[]",
      title: "why spool",
      body: "single-writer means MCP writes must go through the spool",
      session_id: "",
      created_at: 2,
      vector: vecFor("webhook"),
    },
  ]);
  await (await store.table(TABLES.messages)).add([
    {
      id: "msg-1",
      session_id: "sess-1",
      ts: Date.parse("2026-07-09T10:00:00"),
      role: "assistant",
      seq: 0,
      content: "the webhook never sets the org context so RLS hides the row",
      repo: "/r/django",
      profile: "work",
      vector: vecFor("webhook"),
    },
    {
      id: "msg-2",
      session_id: "sess-2",
      ts: Date.parse("2026-06-01T10:00:00"),
      role: "user",
      seq: 0,
      content: "the signal plan mismatch on seengen",
      repo: "/r/django",
      profile: "work",
      vector: vecFor("signal"),
    },
  ]);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("memory_search", () => {
  it("finds active memories and excludes superseded by default", async () => {
    const out = await memorySearch(ctx, { query: "webhook org context" });
    expect(out).toContain("webhook RLS org context");
    expect(out).not.toContain("old superseded note");
  });

  it("respects repo and kind filters", async () => {
    const none = await memorySearch(ctx, {
      query: "webhook",
      repo: "/r/other",
    });
    expect(none).toBe("No matching memories.");
    const kind = await memorySearch(ctx, { query: "webhook", kind: "decision" });
    expect(kind).toContain("webhook RLS org context");
  });
});

describe("work_recall", () => {
  it("spans journal and conversation with date filtering", async () => {
    const out = await workRecall(ctx, {
      query: "webhook RLS",
      date_from: "2026-07-01",
    });
    expect(out).toContain("[journal 2026-07-09");
    expect(out).toContain("[conversation 2026-07-09");
    expect(out).not.toContain("signal plan"); // june message filtered out
  });
});

describe("write tools use the spool (single-writer)", () => {
  it("memory_save queues a valid mem file and does not write the table", async () => {
    const before = await (await store.table(TABLES.codebaseMemory)).countRows();
    const out = await memorySave(ctx, {
      kind: "gotcha",
      title: "new insight",
      body: "spool it",
      repo: "/r/django",
    });
    expect(out).toMatch(/Saved memory mem-/);
    expect(await (await store.table(TABLES.codebaseMemory)).countRows()).toBe(before);

    const files = (await readdir(path.join(tmp, "spool"))).filter((f) =>
      f.startsWith("mem-"),
    );
    expect(files.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(
      await readFile(path.join(tmp, "spool", files[0]), "utf8"),
    );
    expect(parsed.table).toBe("codebase_memory");
    expect(parsed.row.title).toBe("new insight");
    expect(parsed.row.status).toBe("active");
  });

  it("journal_note queues a daily entry for today", async () => {
    const out = await journalNote(ctx, { text: "thinking out loud" });
    expect(out).toMatch(/Journal note note-/);
    const files = (await readdir(path.join(tmp, "spool"))).filter((f) =>
      f.startsWith("mem-"),
    );
    const contents = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(path.join(tmp, "spool", f), "utf8"))),
    );
    expect(contents.some((c) => c.table === "daily_memory" && c.row.kind === "entry")).toBe(true);
  });
});

describe("daily_brief", () => {
  it("renders day doc + notes for a date", async () => {
    const out = await dailyBrief(ctx, { date: "2026-07-09" });
    expect(out).toContain("# Journal 2026-07-09");
    expect(out).toContain("root-caused the RLS webhook drop");
    expect(out).toContain("why spool");
  });

  it("reports empty days honestly", async () => {
    expect(await dailyBrief(ctx, { date: "1999-01-01" })).toBe(
      "No journal for 1999-01-01.",
    );
  });
});

describe("task tools", () => {
  it("tasks_today lists open tasks from the store", async () => {
    await (await store.table(TABLES.tasks)).add([
      {
        id: "github:o/r#7",
        source: "github",
        source_id: "o/r#7",
        title: "Add web dashboard",
        description: '{"raw_status":"OPEN","due":"2026-07-11","body":""}',
        status: "in_progress",
        sprint: "v1",
        url: "u",
        repo: "",
        branch: "feat/web",
        pr_url: "",
        assignee: "me",
        updated_at: 1,
        synced_at: 1,
        vector: vecFor("webhook"),
      },
      {
        id: "clickup:done1",
        source: "clickup",
        source_id: "done1",
        title: "finished thing",
        description: "{}",
        status: "done",
        sprint: "",
        url: "u",
        repo: "",
        branch: "",
        pr_url: "",
        assignee: "me",
        updated_at: 1,
        synced_at: 1,
        vector: vecFor("webhook"),
      },
    ]);
    const { tasksToday } = await import("../src/handlers.js");
    const out = await tasksToday(ctx);
    expect(out).toContain("o/r#7: Add web dashboard");
    expect(out).toContain("(due: 2026-07-11)");
    expect(out).not.toContain("finished thing"); // done excluded
  });

  it("task_update queues a local spool transition + journal comment", async () => {
    const { taskUpdate } = await import("../src/handlers.js");
    const out = await taskUpdate(ctx, {
      ref: "o/r#7",
      status: "review",
      comment: "implementation done, needs eyes",
    });
    expect(out).toContain("o/r#7 -> review");
    const files = (await readdir(path.join(tmp, "spool"))).filter((f) =>
      f.startsWith("mem-"),
    );
    const writes = await Promise.all(
      files.map(async (f) =>
        JSON.parse(await readFile(path.join(tmp, "spool", f), "utf8")),
      ),
    );
    const taskWrite = writes.find((w) => w.table === "tasks");
    expect(taskWrite.row.id).toBe("github:o/r#7");
    expect(taskWrite.row.status).toBe("review");
    expect(taskWrite.row.vector).toBeUndefined(); // vector stripped, daemon re-embeds
    const note = writes.find(
      (w) => w.table === "daily_memory" && String(w.row.title).includes("o/r#7"),
    );
    expect(note).toBeDefined();
  });
});
