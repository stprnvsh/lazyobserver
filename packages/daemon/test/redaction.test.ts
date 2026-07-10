/**
 * Requirements encoded here:
 *  - With redaction ENABLED, secrets are scrubbed at CAPTURE time: event
 *    payloads (hook spool) and memory-plane writes (mem spool) land in the
 *    store already clean.
 *  - With redaction disabled (the default), content is stored verbatim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, saveConfig, Store, TABLES } from "@lazyobserver/core";

import { Writer } from "../src/ingest/writer.js";
import { queueMemWrite } from "../src/memwrite.js";
import { processSpoolOnce } from "../src/spool.js";

let tmp: string;
let store: Store;
let writer: Writer;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(384).fill(0.1));

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GH_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456";

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-redact-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  await mkdir(path.join(tmp, "spool"), { recursive: true });
  const cfg = await loadConfig();
  cfg.settings.redaction.enabled = true;
  await saveConfig(cfg);
  store = await Store.open();
  await store.ensureTables();
  writer = new Writer(store, fakeEmbed);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("capture-time redaction (enabled)", () => {
  it("scrubs hook event payloads before they reach the events table", async () => {
    await writeFile(
      path.join(tmp, "spool", "evt-red1.json"),
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-r",
        cwd: "/r/x",
        prompt: `use key ${AWS_KEY} for the deploy`,
      }) + `\n{"_lzo":{"ts":1000}}\n`,
    );
    await processSpoolOnce(writer);
    const rows = await (await store.table(TABLES.events))
      .query()
      .where("id = 'red1'")
      .toArray();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].payload)).not.toContain(AWS_KEY);
    expect(String(rows[0].payload)).toContain("[REDACTED:aws-key-id]");
  });

  it("scrubs memory writes (journal notes with pasted tokens)", async () => {
    await queueMemWrite({
      table: TABLES.dailyMemory,
      row: {
        id: "note-red",
        date: "2026-07-10",
        kind: "entry",
        workspaces: "[]",
        title: "debugging auth",
        body: `the token ${GH_TOKEN} was rejected`,
        session_id: "",
        created_at: 1,
      },
    });
    await processSpoolOnce(writer);
    const rows = await (await store.table(TABLES.dailyMemory))
      .query()
      .where("id = 'note-red'")
      .toArray();
    expect(String(rows[0].body)).not.toContain(GH_TOKEN);
    expect(String(rows[0].body)).toContain("[REDACTED:github-token]");
  });

  it("stores verbatim once redaction is switched off", async () => {
    const cfg = await loadConfig();
    cfg.settings.redaction.enabled = false;
    await saveConfig(cfg);
    await writeFile(
      path.join(tmp, "spool", "evt-red2.json"),
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-r",
        cwd: "/r/x",
        prompt: `use key ${AWS_KEY} again`,
      }) + `\n{"_lzo":{"ts":2000}}\n`,
    );
    await processSpoolOnce(writer);
    const rows = await (await store.table(TABLES.events))
      .query()
      .where("id = 'red2'")
      .toArray();
    expect(String(rows[0].payload)).toContain(AWS_KEY);
  });
});
