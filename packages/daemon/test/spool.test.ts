/**
 * Requirements encoded here:
 *  - Spool files (hook payload + _lzo envelope) become `events` rows with the
 *    right kind/actor mapping (prompt/file_edit/command/tool_call/lifecycle).
 *  - repo is normalized from cwd; workspace resolved from config.
 *  - Oversized tool payloads are capped (~8KB) keeping identifying fields —
 *    the full content lives in transcripts, not the event trace.
 *  - Files are deleted after a successful flush; ids derive from filenames so
 *    replays after a crash are idempotent.
 *  - Sessions get touched (started/ended/surface/repo) from events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addWorkspace, Store, TABLES } from "@lazyobserver/core";

import { Writer } from "../src/ingest/writer.js";
import { parseSpoolFile, processSpoolOnce, surfaceFromEnvelope } from "../src/spool.js";

let tmp: string;
let store: Store;
let writer: Writer;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(384).fill(0.1));

function spoolFile(name: string, payload: unknown, env: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n${JSON.stringify({ _lzo: env })}\n`;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-spool-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  await addWorkspace("transcality", { repos: ["/Users/x/django_base_login"] });
  store = await Store.open();
  await store.ensureTables();
  writer = new Writer(store, fakeEmbed);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseSpoolFile / surface", () => {
  it("splits payload from _lzo envelope", () => {
    const evt = parseSpoolFile(
      spoolFile("x", { hook_event_name: "Stop", session_id: "s" }, { term: "vscode", ts: 123 }),
    )!;
    expect(evt.payload.hook_event_name).toBe("Stop");
    expect(evt.envelope.ts).toBe(123);
    expect(surfaceFromEnvelope(evt.envelope)).toBe("vscode");
  });

  it("tolerates a missing envelope and garbage", () => {
    expect(parseSpoolFile('{"hook_event_name":"Stop"}')).not.toBeNull();
    expect(parseSpoolFile("garbage")).toBeNull();
    expect(parseSpoolFile("")).toBeNull();
  });
});

describe("processSpoolOnce", () => {
  it("ingests a realistic mix and empties the spool", async () => {
    const spool = path.join(tmp, "spool");
    const cwd = "/Users/x/django_base_login/";
    const write = (n: string, p: unknown): Promise<void> =>
      writeFile(path.join(spool, n), spoolFile(n, p, { term: "vscode", ts: 1000 }));

    await write("evt-a1.json", {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-9",
      cwd,
      prompt: "fix the webhook",
    });
    await write("evt-a2.json", {
      hook_event_name: "PostToolUse",
      session_id: "sess-9",
      cwd,
      tool_name: "Edit",
      tool_input: { file_path: "/x/y.py" },
      tool_response: "ok",
    });
    await write("evt-a3.json", {
      hook_event_name: "PostToolUse",
      session_id: "sess-9",
      cwd,
      tool_name: "Bash",
      tool_input: { command: "pytest -q" },
      tool_response: "z".repeat(50_000), // must be capped
    });
    await write("evt-a4.json", { hook_event_name: "SessionEnd", session_id: "sess-9", cwd });

    const n = await processSpoolOnce(writer);
    expect(n).toBe(4);
    expect(
      (await readdir(spool)).filter((f) => f.startsWith("evt-")),
    ).toHaveLength(0); // spool drained

    const tbl = await store.table(TABLES.events);
    const rows = await tbl.query().where("session_id = 'sess-9'").toArray();
    expect(rows).toHaveLength(4);

    const byId = new Map(rows.map((r) => [r.id as string, r]));
    expect(byId.get("a1")).toMatchObject({ kind: "prompt", actor: "user" });
    expect(byId.get("a2")).toMatchObject({ kind: "file_edit", actor: "agent" });
    expect(byId.get("a3")).toMatchObject({ kind: "command", actor: "agent" });
    expect(byId.get("a4")).toMatchObject({ kind: "session_end", actor: "system" });

    // normalization + workspace resolution
    expect(byId.get("a1")!.repo).toBe("/Users/x/django_base_login");
    expect(byId.get("a1")!.workspace).toBe("transcality");
    expect(byId.get("a1")!.surface).toBe("vscode");

    // payload cap kept identifying fields
    const capped = JSON.parse(byId.get("a3")!.payload as string);
    expect(capped._truncated).toBe(true);
    expect(capped.tool_name).toBe("Bash");
    expect((byId.get("a3")!.payload as string).length).toBeLessThanOrEqual(8192);

    // session rollup touched
    const sess = await (await store.table(TABLES.sessions))
      .query()
      .where("id = 'sess-9'")
      .toArray();
    expect(sess).toHaveLength(1);
    expect(sess[0].repo).toBe("/Users/x/django_base_login");
  });

  it("capped payloads are ALWAYS valid JSON — even with a huge prompt", async () => {
    // regression: a >8KB prompt once got blind-sliced mid-string; the invalid
    // row then killed every consumer that parsed payloads (web Today view)
    const spool = path.join(tmp, "spool");
    await writeFile(
      path.join(spool, "evt-huge.json"),
      spoolFile("evt-huge.json", {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-huge",
        cwd: "/Users/x/django_base_login",
        prompt: "P".repeat(50_000),
      }, { term: "vscode", ts: 2000 }),
    );
    await processSpoolOnce(writer);
    const rows = await (await store.table(TABLES.events))
      .query()
      .where("id = 'huge'")
      .toArray();
    expect(rows).toHaveLength(1);
    const payload = String(rows[0].payload);
    expect(payload.length).toBeLessThanOrEqual(8192);
    const parsed = JSON.parse(payload); // must NOT throw
    expect(parsed._truncated).toBe(true);
    expect(String(parsed.prompt).length).toBeLessThanOrEqual(2000);
  });

  it("is idempotent on replay (same filenames -> same ids)", async () => {
    const spool = path.join(tmp, "spool");
    await writeFile(
      path.join(spool, "evt-a1.json"),
      spoolFile("evt-a1.json", {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-9",
        cwd: "/Users/x/django_base_login",
        prompt: "fix the webhook",
      }, { ts: 1000 }),
    );
    await processSpoolOnce(writer);
    const tbl = await store.table(TABLES.events);
    const rows = await tbl.query().where("id = 'a1'").toArray();
    expect(rows).toHaveLength(1); // merged, not duplicated
  });
});
