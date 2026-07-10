/**
 * Requirements encoded here:
 *  - OTLP/HTTP JSON log records named *api_request* become `api_request`
 *    events carrying tokens + cost and update the session's cost/model.
 *  - Malformed/protobuf bodies are acknowledged (200) and dropped — the
 *    receiver must never make a session's exporter retry-spin.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, TABLES } from "@lazyobserver/core";

import { Writer } from "../src/ingest/writer.js";
import { ingestOtlpLogs, startOtlpServer } from "../src/otlp.js";

let tmp: string;
let store: Store;
let writer: Writer;

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array(384).fill(0));

function otlpBody(sessionId: string): unknown {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1783700000000000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  { key: "event.name", value: { stringValue: "claude_code.api_request" } },
                  { key: "session.id", value: { stringValue: sessionId } },
                  { key: "model", value: { stringValue: "claude-opus-4-8" } },
                  { key: "input_tokens", value: { intValue: "1200" } },
                  { key: "output_tokens", value: { intValue: "340" } },
                  { key: "cost_usd", value: { doubleValue: 0.0456 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-otlp-"));
  process.env.LAZYOBSERVER_HOME = tmp;
  store = await Store.open();
  await store.ensureTables();
  writer = new Writer(store, fakeEmbed);
});

afterAll(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("OTLP ingestion", () => {
  it("maps api_request log records to events with tokens and cost", async () => {
    const n = ingestOtlpLogs(otlpBody("sess-otlp"), writer);
    expect(n).toBe(1);
    await writer.flush();

    const rows = await (await store.table(TABLES.events))
      .query()
      .where("kind = 'api_request' AND session_id = 'sess-otlp'")
      .toArray();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].tokens_in)).toBe(1200);
    expect(Number(rows[0].tokens_out)).toBe(340);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0456, 6);

    const sess = await (await store.table(TABLES.sessions))
      .query()
      .where("id = 'sess-otlp'")
      .toArray();
    expect(Number(sess[0].cost_usd)).toBeCloseTo(0.0456, 6);
    expect(sess[0].model).toBe("claude-opus-4-8");
  });

  it("HTTP server accepts logs, tolerates garbage, answers 200", async () => {
    const server = await startOtlpServer(writer, 43977);
    try {
      const good = await fetch("http://127.0.0.1:43977/v1/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpBody("sess-http")),
      });
      expect(good.status).toBe(200);

      const garbage = await fetch("http://127.0.0.1:43977/v1/logs", {
        method: "POST",
        body: Buffer.from([0x0a, 0xff, 0x00, 0x12]), // protobuf-ish bytes
      });
      expect(garbage.status).toBe(200);

      const metrics = await fetch("http://127.0.0.1:43977/v1/metrics", {
        method: "POST",
        body: "{}",
      });
      expect(metrics.status).toBe(200);

      await writer.flush();
      const rows = await (await store.table(TABLES.events))
        .query()
        .where("session_id = 'sess-http'")
        .toArray();
      expect(rows).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
