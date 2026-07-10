/**
 * Requirements encoded here:
 *  - Status mapping: ClickUp per-list customs (via type + name heuristics)
 *    and GitHub state+labels normalize into the unified vocabulary.
 *  - ClickUp adapter pulls assigned-to-me tasks and pushes done using the
 *    LIST'S OWN done-type status name (statuses are per-list customs).
 *  - GitHub adapter pulls open assigned issues; complete = comment + close.
 *  - Sync writes ONLY spool upserts and PRESERVES local fields
 *    (repo/branch/pr_url survive a re-pull).
 *  - Task ids: `${source}:${source_id}` — deterministic upserts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import { ClickUpAdapter, type FetchFn } from "../src/lib/tasks/clickup.js";
import { GitHubAdapter } from "../src/lib/tasks/github.js";
import {
  mapClickUpStatus,
  mapGitHubStatus,
} from "../src/lib/tasks/model.js";
import { syncTasks } from "../src/lib/tasks/sync.js";

let tmp: string;
let store: Store;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-tasks-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  process.env.LAZYOBSERVER_SECRETS_FILE = path.join(tmp, "secrets.json");
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  store = await Store.open();
  await store.ensureTables();
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  delete process.env.LAZYOBSERVER_SECRETS_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

describe("status mapping", () => {
  it("maps ClickUp status types + names", () => {
    expect(mapClickUpStatus({ status: "to do", type: "open" })).toBe("todo");
    expect(mapClickUpStatus({ status: "in progress", type: "custom" })).toBe("in_progress");
    expect(mapClickUpStatus({ status: "code review", type: "custom" })).toBe("review");
    expect(mapClickUpStatus({ status: "blocked", type: "custom" })).toBe("blocked");
    expect(mapClickUpStatus({ status: "complete", type: "done" })).toBe("done");
    expect(mapClickUpStatus({ status: "Closed", type: "closed" })).toBe("done");
  });

  it("maps GitHub state + labels", () => {
    expect(mapGitHubStatus({ state: "OPEN" })).toBe("todo");
    expect(mapGitHubStatus({ state: "open", labels: [{ name: "in-progress" }] })).toBe("in_progress");
    expect(mapGitHubStatus({ state: "open", labels: [{ name: "blocked" }] })).toBe("blocked");
    expect(mapGitHubStatus({ state: "CLOSED" })).toBe("done");
  });
});

describe("ClickUp adapter", () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fakeFetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    const respond = (data: unknown): { ok: true; status: 200; json(): Promise<unknown> } => ({
      ok: true,
      status: 200,
      json: async () => data,
    });
    if (url.endsWith("/user")) return respond({ user: { id: 42 } });
    if (url.includes("/team/9/task"))
      return respond({
        tasks: [
          {
            id: "abc1",
            name: "Fix the webhook",
            text_content: "RLS drops it",
            status: { status: "in progress", type: "custom" },
            url: "https://app.clickup.com/t/abc1",
            due_date: String(Date.parse("2026-07-11T12:00:00")),
            date_updated: "1783700000000",
            assignees: [{ username: "pranav" }],
            list: { id: "L1", name: "Sprint 12" },
          },
        ],
      });
    if (url.endsWith("/task/abc1")) return respond({ list: { id: "L1" } });
    if (url.endsWith("/list/L1"))
      return respond({
        statuses: [
          { status: "to do", type: "open" },
          { status: "shipped", type: "done" },
        ],
      });
    return respond({});
  };
  const adapter = new ClickUpAdapter("9", [], fakeFetch, async () => "tok-123");

  it("pulls assigned-to-me tasks with sprint + due", async () => {
    const tasks = await adapter.pull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "clickup:abc1",
      status: "in_progress",
      raw_status: "in progress",
      sprint: "Sprint 12",
      due: "2026-07-11",
      assignee: "pranav",
    });
  });

  it("complete uses the list's done-type status and comments", async () => {
    calls.length = 0;
    await adapter.complete("abc1", "Completed via lazyobserver — branch x");
    const put = calls.find((c) => c.method === "PUT");
    expect(put!.body).toContain('"status":"shipped"');
    const comment = calls.find((c) => c.url.endsWith("/comment"));
    expect(comment!.body).toContain("Completed via lazyobserver");
  });
});

describe("ClickUp team discovery (API-key-only connect)", () => {
  it("lists the teams a key can see", async () => {
    const { discoverClickUpTeams } = await import("../src/lib/tasks/clickup.js");
    const fakeFetch: FetchFn = async (url) => ({
      ok: url.endsWith("/team"),
      status: url.endsWith("/team") ? 200 : 404,
      json: async () => ({ teams: [{ id: 9007, name: "Transcality" }] }),
    });
    const teams = await discoverClickUpTeams("pk_x", fakeFetch);
    expect(teams).toEqual([{ id: "9007", name: "Transcality" }]);
  });

  it("surfaces invalid keys clearly", async () => {
    const { discoverClickUpTeams } = await import("../src/lib/tasks/clickup.js");
    const fakeFetch: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(discoverClickUpTeams("bad", fakeFetch)).rejects.toThrow(/401.*invalid API key/);
  });
});

describe("GitHub adapter", () => {
  const ghCalls: string[][] = [];
  const fakeGh = async (args: string[]): Promise<string> => {
    ghCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify([
        {
          number: 7,
          title: "Add web dashboard",
          body: "M5",
          state: "OPEN",
          url: "https://github.com/o/r/issues/7",
          labels: [{ name: "in-progress" }],
          milestone: { title: "v1" },
          assignees: [{ login: "stprnvsh" }],
          updatedAt: "2026-07-10T10:00:00Z",
        },
      ]);
    }
    return "";
  };
  const adapter = new GitHubAdapter(["o/r"], fakeGh);

  it("pulls open assigned issues", async () => {
    const tasks = await adapter.pull();
    expect(tasks[0]).toMatchObject({
      id: "github:o/r#7",
      status: "in_progress",
      sprint: "v1",
      assignee: "stprnvsh",
    });
  });

  it("complete comments then closes", async () => {
    ghCalls.length = 0;
    await adapter.complete("o/r#7", "done note");
    expect(ghCalls[0].slice(0, 2)).toEqual(["issue", "comment"]);
    expect(ghCalls[1].slice(0, 2)).toEqual(["issue", "close"]);
  });
});

describe("sync engine", () => {
  it("writes spool upserts only, preserving local repo/branch fields", async () => {
    // seed an existing local row with a linked branch
    await (await store.table(TABLES.tasks)).add([
      {
        id: "github:o/r#7",
        source: "github",
        source_id: "o/r#7",
        title: "Add web dashboard",
        description: '{"raw_status":"OPEN","due":"","body":"M5"}',
        status: "in_progress",
        sprint: "v1",
        url: "https://github.com/o/r/issues/7",
        repo: "/Users/x/lazyobserver",
        branch: "feat/web",
        pr_url: "",
        assignee: "stprnvsh",
        updated_at: 1,
        synced_at: 1,
        vector: new Array(384).fill(0),
      },
    ]);
    const fakeGh = async (args: string[]): Promise<string> =>
      args[0] === "issue" && args[1] === "list"
        ? JSON.stringify([
            {
              number: 7,
              title: "Add web dashboard",
              body: "M5",
              state: "OPEN",
              url: "https://github.com/o/r/issues/7",
              labels: [],
              assignees: [],
            },
          ])
        : "";
    const before = await (await store.table(TABLES.tasks)).countRows();
    const res = await syncTasks(store, { github: new GitHubAdapter(["o/r"], fakeGh) });
    expect(res.pulled).toBe(1);
    expect(res.errors).toEqual([]);
    // no direct writes
    expect(await (await store.table(TABLES.tasks)).countRows()).toBe(before);
    // spool row preserved the linked branch
    const spool = (await readdir(path.join(tmp, "spool"))).filter((f) =>
      f.startsWith("mem-"),
    );
    expect(spool.length).toBeGreaterThanOrEqual(1);
    const write = JSON.parse(
      await readFile(path.join(tmp, "spool", spool[spool.length - 1]), "utf8"),
    );
    expect(write.table).toBe("tasks");
    expect(write.row.id).toBe("github:o/r#7");
    expect(write.row.branch).toBe("feat/web");
    expect(write.row.repo).toBe("/Users/x/lazyobserver");
  });
});
