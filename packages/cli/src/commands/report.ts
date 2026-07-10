/** `lzo report` — assemble + print/export the daily observability report. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, localDate, paths, redactSecrets, Store } from "@lazyobserver/core";

import { assembleReport, renderHtml, renderMarkdown } from "../lib/report.js";
import { startWebServer } from "../lib/webserver.js";
import { heading, info, ok } from "../ui.js";

export async function reportCommand(opts: {
  date?: string;
  export?: string;
}): Promise<void> {
  const date = opts.date ?? localDate();
  const store = await Store.open();
  const r = await assembleReport(store, date);
  const cfg = await loadConfig();
  const scrub = (s: string): string =>
    cfg.settings.redaction.enabled ? redactSecrets(s).text : s;

  if (opts.export) {
    await mkdir(paths.exports(), { recursive: true });
    const file = path.join(paths.exports(), `report-${date}.${opts.export}`);
    const body =
      opts.export === "json"
        ? scrub(JSON.stringify(r, null, 2))
        : opts.export === "html"
          ? scrub(renderHtml(r))
          : scrub(renderMarkdown(r));
    await writeFile(file, body, "utf8");
    ok(`exported: ${file}`);
    return;
  }
  console.log(scrub(renderMarkdown(r)));
}

export async function webCommand(opts: { port: string }): Promise<void> {
  const port = Number(opts.port) || 43180;
  await startWebServer(port);
  const url = `http://127.0.0.1:${port}`;
  ok(`lazyobserver web running at ${url}`);
  heading("views");
  info("Today (report + timeline) · Tasks · Journal · Search — exports top-right");
  execFile("open", [url], () => undefined); // macOS convenience
  await new Promise(() => undefined); // keep serving until Ctrl-C
}
