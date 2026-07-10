/**
 * The local web app (`lzo web`) — full observability in the browser.
 * Read-only over the store (MVCC-safe next to the daemon), localhost only.
 * Zero frontend dependencies: one self-contained page + a JSON API.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { URL } from "node:url";

import {
  Embedder,
  loadConfig,
  localDate,
  redactSecrets,
  smartSearch,
  Store,
  TABLES,
} from "@lazyobserver/core";

import { assembleReport, renderHtml, renderMarkdown } from "./report.js";
import { DASHBOARD_HTML } from "./webhtml.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The built React app (@lazyobserver/web/dist); null when not built. */
function webDistDir(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_.resolve("@lazyobserver/web/package.json");
    const dir = path.join(path.dirname(pkg), "dist");
    return existsSync(path.join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
}

export async function startWebServer(port: number): Promise<http.Server> {
  const store = await Store.open();
  let embedder: Embedder | null = null;
  const dist = webDistDir();

  const json = (res: http.ServerResponse, data: unknown): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const date = url.searchParams.get("date") ?? localDate();

      if (url.pathname === "/" || url.pathname.startsWith("/assets/")) {
        // the React app when built; the embedded vanilla page as fallback
        if (dist) {
          const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const file = path.resolve(dist, rel);
          if (!file.startsWith(dist)) {
            res.writeHead(403).end();
            return;
          }
          try {
            const body = await readFile(file);
            res.writeHead(200, {
              "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
            });
            res.end(body);
          } catch {
            res.writeHead(404).end("not found");
          }
        } else {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(DASHBOARD_HTML);
        }
      } else if (url.pathname === "/api/report") {
        const r = await assembleReport(store, date);
        json(res, r);
      } else if (url.pathname === "/api/tasks") {
        const rows = await (await store.table(TABLES.tasks))
          .query()
          .limit(2000)
          .toArray();
        json(res, rows.map((r) => ({ ...r, vector: undefined })));
      } else if (url.pathname === "/api/journal") {
        const rows = await (await store.table(TABLES.dailyMemory))
          .query()
          .where(`date = '${date.replace(/'/g, "")}'`)
          .limit(300)
          .toArray();
        json(res, rows.map((r) => ({ ...r, vector: undefined })));
      } else if (url.pathname === "/api/events") {
        const session = url.searchParams.get("session") ?? "";
        const from = Date.parse(`${date}T00:00:00`);
        const to = Date.parse(`${date}T23:59:59`);
        const where = session
          ? `session_id = '${session.replace(/'/g, "")}'`
          : `ts >= ${from} AND ts <= ${to}`;
        const rows = await (await store.table(TABLES.events))
          .query()
          .where(where)
          .limit(3000)
          .toArray();
        json(
          res,
          (rows as { ts: number }[]).sort((a, b) => a.ts - b.ts),
        );
      } else if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return json(res, { memory: [], messages: [] });
        embedder ??= new Embedder();
        const vector = await embedder.embedOne(q);
        const [mem, msgs] = await Promise.all([
          smartSearch(store, TABLES.codebaseMemory, {
            query: q,
            vector,
            k: 8,
            where: "status = 'active'",
          }),
          smartSearch(store, TABLES.messages, { query: q, vector, k: 8 }),
        ]);
        json(res, {
          memory: mem.rows.map((r) => ({ ...r, vector: undefined })),
          messages: msgs.rows.map((r) => ({ ...r, vector: undefined })),
        });
      } else if (url.pathname.startsWith("/export/")) {
        const m = url.pathname.match(/^\/export\/(\d{4}-\d{2}-\d{2})\.(md|html|json)$/);
        if (!m) {
          res.writeHead(404).end("bad export path");
          return;
        }
        const r = await assembleReport(store, m[1]);
        const cfg = await loadConfig();
        const scrub = (s: string): string =>
          cfg.settings.redaction.enabled ? redactSecrets(s).text : s;
        if (m[2] === "json")
          return json(res, JSON.parse(scrub(JSON.stringify(r))));
        const body = scrub(m[2] === "md" ? renderMarkdown(r) : renderHtml(r));
        res.writeHead(200, {
          "content-type": m[2] === "md" ? "text/markdown" : "text/html",
          "content-disposition": `attachment; filename="lazyobserver-${m[1]}.${m[2]}"`,
        });
        res.end(body);
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
