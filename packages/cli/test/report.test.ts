/**
 * Requirements encoded here:
 *  - assembleReport computes: totals (sessions/minutes/tokens/cost from the
 *    sessions table), user-vs-agent split from event kinds, tasks done
 *    today vs open, per-task minutes from task-tagged events (10-min slices)
 *    AND branch-matched sessions, day decisions, and the day doc.
 *  - renderers: markdown carries every section; html embeds the numbers;
 *    export shape is stable for the web dashboard.
 *  - The web server serves /, /api/report, /api/tasks and /export/*.md
 *    from the same assembly (one source of truth).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import { assembleReport, renderHtml, renderMarkdown } from "../src/lib/report.js";
import { startWebServer } from "../src/lib/webserver.js";

let tmp: string;
let store: Store;
const DAY = "2026-07-10";
const T0 = Date.parse(`${DAY}T09:00:00`);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-report-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  store = await Store.open();
  await store.ensureTables();

  await (await store.table(TABLES.sessions)).add([
    {
      id: "s-1",
      started_at: T0,
      ended_at: T0 + 60 * 60_000,
      repo: "/r/django",
      workspace: "transcality",
      branch: "feat/web",
      profile: "work",
      surface: "vscode",
      model: "claude-opus-4-8",
      tokens_in: 5000,
      tokens_out: 2000,
      cost_usd: 1.25,
      summary: "",
      vector: new Array(384).fill(0),
    },
  ]);
  await (await store.table(TABLES.events)).add([
    // task-tagged events in two distinct 10-min slices -> 20 minutes
    ...[0, 1].map((i) => ({
      id: `e-t${i}`,
      ts: T0 + i * 600_000,
      session_id: "s-1",
      surface: "vscode",
      actor: "agent",
      kind: "command",
      repo: "/r/django",
      workspace: "transcality",
      branch: "",
      task_id: "github:o/r#7",
      payload: "{}",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    })),
    {
      id: "e-p",
      ts: T0,
      session_id: "s-1",
      surface: "vscode",
      actor: "user",
      kind: "prompt",
      repo: "/r/django",
      workspace: "transcality",
      branch: "",
      task_id: "",
      payload: "{}",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    },
  ]);
  await (await store.table(TABLES.tasks)).add([
    {
      id: "github:o/r#7",
      source: "github",
      source_id: "o/r#7",
      title: "Add web dashboard",
      description: '{"raw_status":"OPEN","due":"","body":""}',
      status: "in_progress",
      sprint: "v1",
      url: "u",
      repo: "/r/django",
      branch: "feat/web",
      pr_url: "",
      assignee: "me",
      updated_at: T0,
      synced_at: T0,
      vector: new Array(384).fill(0),
    },
    {
      id: "clickup:z9",
      source: "clickup",
      source_id: "z9",
      title: "Ship reports",
      description: '{"raw_status":"complete","due":"","body":""}',
      status: "done",
      sprint: "Sprint 12",
      url: "u2",
      repo: "",
      branch: "",
      pr_url: "https://github.com/o/r/pull/9",
      assignee: "me",
      updated_at: T0 + 3_600_000, // done today
      synced_at: T0,
      vector: new Array(384).fill(0),
    },
  ]);
  await (await store.table(TABLES.decisions)).add([
    {
      id: "d-1",
      date: DAY,
      session_id: "s-1",
      repo: "/r/django",
      context: "web stack",
      options: '["react","vanilla"]',
      choice: "vanilla self-contained page",
      rationale: "zero deps, localhost-only",
      proposed_by: "agent",
      decided_by: "user",
      links: "{}",
      vector: new Array(384).fill(0),
    },
  ]);
  await (await store.table(TABLES.dailyMemory)).add([
    {
      id: `day-${DAY}`,
      date: DAY,
      kind: "day_doc",
      workspaces: '["transcality"]',
      title: "Built M4+M5",
      body: "tasks + reports + web",
      session_id: "",
      created_at: T0,
      vector: new Array(384).fill(0),
    },
  ]);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("assembleReport", () => {
  it("computes totals, task split, per-task time, decisions, day doc", async () => {
    const r = await assembleReport(store, DAY);
    expect(r.totals).toMatchObject({
      sessions: 1,
      minutes: 60,
      tokensIn: 5000,
      tokensOut: 2000,
      userPrompts: 1,
      agentActions: 2,
    });
    expect(r.totals.costUsd).toBeCloseTo(1.25, 2);
    expect(r.tasks.doneToday.map((t) => t.id)).toEqual(["clickup:z9"]);
    expect(r.tasks.open.map((t) => t.id)).toEqual(["github:o/r#7"]);
    expect(r.tasks.percentDone).toBe(50);
    // two distinct 10-min slices of tagged events
    expect(r.tasks.minutesByTask["github:o/r#7"]).toBe(20);
    expect(r.decisions[0].choice).toContain("vanilla");
    expect(r.dayDoc?.title).toBe("Built M4+M5");
  });
});

describe("renderers", () => {
  it("markdown contains every section", async () => {
    const md = renderMarkdown(await assembleReport(store, DAY));
    for (const needle of [
      "# Daily report — 2026-07-10",
      "**Sessions:** 1 (60 min)",
      "Completed today",
      "✅ z9: Ship reports (PR: https://github.com/o/r/pull/9)",
      "[in_progress] o/r#7: Add web dashboard — feat/web — ~20m today",
      "**vanilla self-contained page**",
      "## Day document",
    ]) {
      expect(md).toContain(needle);
    }
  });

  it("html embeds the key numbers", async () => {
    const html = renderHtml(await assembleReport(store, DAY));
    expect(html).toContain("<b>1</b><span>sessions (60m)</span>");
    expect(html).toContain("50%");
  });
});

describe("web server", () => {
  it("serves the dashboard, the API and exports from one assembly", async () => {
    const server = await startWebServer(43981);
    try {
      const page = await fetch("http://127.0.0.1:43981/");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("lazyobserver");

      const rep = (await (
        await fetch(`http://127.0.0.1:43981/api/report?date=${DAY}`)
      ).json()) as { totals: { sessions: number } };
      expect(rep.totals.sessions).toBe(1);

      const tasks = (await (
        await fetch("http://127.0.0.1:43981/api/tasks")
      ).json()) as unknown[];
      expect(tasks).toHaveLength(2);

      const md = await fetch(`http://127.0.0.1:43981/export/${DAY}.md`);
      expect(md.status).toBe(200);
      expect(await md.text()).toContain("# Daily report — 2026-07-10");
    } finally {
      server.close();
    }
  });
});
