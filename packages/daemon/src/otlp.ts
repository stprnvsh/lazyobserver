/**
 * Minimal OTLP/HTTP (JSON) receiver on 127.0.0.1 for Claude Code telemetry.
 *
 * We configure sessions with OTEL_EXPORTER_OTLP_PROTOCOL=http/json, so the
 * bodies are plain JSON. Log records named like `claude_code.api_request`
 * carry model / token / cost attributes — the precise per-request accounting
 * that transcripts approximate. Metrics are accepted (200) and dropped:
 * the same numbers arrive via logs.
 */
import http from "node:http";

import type { Writer } from "./ingest/writer.js";

interface OtlpAttr {
  key: string;
  value?: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

function attrsToObject(attrs: OtlpAttr[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    out[a.key] =
      v.stringValue ??
      (v.intValue !== undefined ? Number(v.intValue) : undefined) ??
      v.doubleValue ??
      v.boolValue;
  }
  return out;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function ingestOtlpLogs(body: unknown, writer: Writer): number {
  let count = 0;
  const root = body as {
    resourceLogs?: {
      scopeLogs?: {
        logRecords?: {
          timeUnixNano?: string;
          body?: { stringValue?: string };
          attributes?: OtlpAttr[];
        }[];
      }[];
    }[];
  };
  for (const rl of root.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = attrsToObject(rec.attributes);
        const eventName = String(
          attrs["event.name"] ?? rec.body?.stringValue ?? "",
        );
        if (!eventName.includes("api_request")) continue;

        const sessionId = String(
          attrs["session.id"] ?? attrs["session_id"] ?? "",
        );
        const ts = rec.timeUnixNano
          ? Math.floor(Number(rec.timeUnixNano) / 1e6)
          : Date.now();
        const tokensIn = num(attrs["input_tokens"]);
        const tokensOut = num(attrs["output_tokens"]);
        const cost = num(attrs["cost_usd"]);

        writer.queueEvent({
          id: `otlp-${sessionId}-${ts}-${count}`,
          ts,
          session_id: sessionId,
          surface: "",
          actor: "agent",
          kind: "api_request",
          repo: "",
          workspace: "",
          branch: "",
          task_id: "",
          // truncate VALUES, never the serialized JSON (must stay parseable)
          payload: JSON.stringify(
            Object.fromEntries(
              Object.entries(attrs).map(([k, v]) => [
                k,
                typeof v === "string" ? v.slice(0, 500) : v,
              ]),
            ),
          ),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: cost,
        });
        if (sessionId) {
          writer.touchSession({
            id: sessionId,
            cost_usd: cost,
            model: String(attrs["model"] ?? "") || undefined,
            ended_at: ts,
          } as never);
        }
        count++;
      }
    }
  }
  return count;
}

export function startOtlpServer(
  writer: Writer,
  port: number,
  onEvent?: (n: number) => void,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/logs")) {
        try {
          const n = ingestOtlpLogs(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            writer,
          );
          onEvent?.(n);
        } catch {
          /* protobuf or malformed — acknowledge and drop */
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
