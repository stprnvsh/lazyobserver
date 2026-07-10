/**
 * Requirements encoded here:
 *  - FIRST scan skips pre-existing transcript content (no surprise backfill
 *    of 163MB histories); only lines appended afterwards are ingested.
 *  - Files created after the first scan ingest from byte 0.
 *  - Partial trailing lines are left for the next sweep (no corrupt parses).
 *  - Messages land chunked+embedded with deterministic ids; session rollups
 *    carry repo/branch/surface/model/tokens and workspace resolution.
 *  - Offsets persist across tailer restarts (no re-ingest).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addWorkspace, loadConfig, Store, TABLES, type Config } from "@lazyobserver/core";

import { Writer } from "../src/ingest/writer.js";
import { TranscriptTailer } from "../src/transcript/tailer.js";

let tmp: string;
let store: Store;
let writer: Writer;
let projectsDir: string;
let cfg: Config;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(384).fill(0.2));

function line(type: "user" | "assistant", uuid: string, text: string, extra: object = {}): string {
  const message =
    type === "user"
      ? { role: "user", content: [{ type: "text", text }] }
      : {
          role: "assistant",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text }],
        };
  return (
    JSON.stringify({
      type,
      uuid,
      sessionId: "sess-tail",
      cwd: "/Users/x/django_base_login",
      gitBranch: "feat/x",
      entrypoint: "claude-vscode",
      timestamp: "2026-07-10T10:00:00.000Z",
      message,
      ...extra,
    }) + "\n"
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-tail-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  projectsDir = path.join(tmp, "claude", "projects", "-Users-x-django-base-login");
  await mkdir(projectsDir, { recursive: true });
  await addWorkspace("transcality", { repos: ["/Users/x/django_base_login"] });
  cfg = await loadConfig();
  store = await Store.open();
  await store.ensureTables();
  writer = new Writer(store, fakeEmbed);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("TranscriptTailer", () => {
  const roots = (): { profile: string; dir: string }[] => [
    { profile: "work", dir: path.join(tmp, "claude", "projects") },
  ];

  it("skips pre-existing content on first scan, ingests appends after", async () => {
    const file = path.join(projectsDir, "sess-tail.jsonl");
    await writeFile(file, line("user", "u-old", "HISTORIC — must not ingest"));

    const tailer = new TranscriptTailer(roots(), writer, () => cfg);
    await tailer.loadState();
    expect(await tailer.sweep()).toBe(0); // first scan: offsets -> EOF

    await appendFile(file, line("user", "u-1", "fix the RLS webhook drop"));
    await appendFile(file, line("assistant", "a-1", "Setting org context from payload."));
    expect(await tailer.sweep()).toBe(2);
    await writer.flush();

    const msgs = await (await store.table(TABLES.messages))
      .query()
      .where("session_id = 'sess-tail'")
      .toArray();
    const contents = msgs.map((m) => m.content as string);
    expect(contents.some((c) => c.includes("HISTORIC"))).toBe(false);
    expect(contents.some((c) => c.includes("RLS webhook"))).toBe(true);
    expect(msgs.map((m) => m.id)).toContain("u-1#0#0");

    const sess = await (await store.table(TABLES.sessions))
      .query()
      .where("id = 'sess-tail'")
      .toArray();
    expect(sess[0]).toMatchObject({
      repo: "/Users/x/django_base_login",
      workspace: "transcality",
      branch: "feat/x",
      surface: "vscode",
      model: "claude-opus-4-8",
      profile: "work",
    });
    expect(Number(sess[0].tokens_in)).toBe(100);
    expect(Number(sess[0].tokens_out)).toBe(50);
  });

  it("waits for partial trailing lines", async () => {
    const file = path.join(projectsDir, "sess-tail.jsonl");
    const full = line("user", "u-2", "second prompt");
    const cut = Math.floor(full.length / 2);
    await appendFile(file, full.slice(0, cut)); // no trailing newline

    const tailer = new TranscriptTailer(roots(), writer, () => cfg);
    await tailer.loadState();
    expect(await tailer.sweep()).toBe(0); // partial line not consumed

    await appendFile(file, full.slice(cut));
    expect(await tailer.sweep()).toBe(1);
    await writer.flush();
    const rows = await (await store.table(TABLES.messages))
      .query()
      .where("id = 'u-2#0#0'")
      .toArray();
    expect(rows).toHaveLength(1);
  });

  it("persists offsets across restarts (no re-ingest) and ingests new files from 0", async () => {
    // restart: new tailer instance, same state file
    const tailer = new TranscriptTailer(roots(), writer, () => cfg);
    await tailer.loadState();
    expect(await tailer.sweep()).toBe(0); // nothing new

    const fresh = path.join(projectsDir, "sess-new.jsonl");
    await writeFile(fresh, line("user", "u-3", "brand new session", { sessionId: "sess-new" }));
    // file created AFTER first-ever scan -> ingest from byte 0
    const tailer2 = new TranscriptTailer(roots(), writer, () => cfg);
    await tailer2.loadState();
    expect(await tailer2.sweep()).toBe(1);
  });
});
