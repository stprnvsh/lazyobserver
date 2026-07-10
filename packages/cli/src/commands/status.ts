/** `lzo status` — quick health + data snapshot (row counts per table). */
import { readdir } from "node:fs/promises";

import { loadConfig, paths, Store, TABLES } from "@lazyobserver/core";
import { isAlive, readDaemonState } from "@lazyobserver/daemon";

import { heading, info, ok, warn } from "../ui.js";

export async function statusCommand(): Promise<void> {
  const cfg = await loadConfig();
  heading("lazyobserver");
  info(`home: ${paths.home()}`);
  info(
    `profiles: ${cfg.profiles.map((p) => p.name).join(", ") || "(none)"}`,
  );
  info(
    `workspaces: ${cfg.workspaces.map((w) => w.name).join(", ") || "(none)"}` +
      (cfg.currentWorkspace ? ` — current: ${cfg.currentWorkspace}` : ""),
  );
  info(`redaction: ${cfg.settings.redaction.enabled ? "ON" : "off"}`);

  heading("store");
  const store = await Store.open();
  for (const name of Object.values(TABLES)) {
    const tbl = await store.table(name);
    const count = await tbl.countRows();
    info(`${name.padEnd(16)} ${count} rows`);
  }

  heading("capture");
  const state = await readDaemonState();
  const alive = state !== null && isAlive(state.pid);
  const fresh = state !== null && Date.now() - state.lastBeat < 15_000;
  if (alive && fresh) {
    const up = Math.round((Date.now() - state.startedAt) / 60_000);
    ok(`daemon running (pid ${state.pid}, up ${up}m)`);
    const c = state.counters;
    info(
      `ingested: ${c.events} events · ${c.messages} messages · ${c.sessions} session upserts`,
    );
    info(
      `transcripts tracked: ${c.filesTracked} files · ${c.transcriptLines} lines parsed · otlp: ${c.otlpEvents}`,
    );
  } else if (alive) {
    warn(`daemon pid ${state.pid} alive but heartbeat is stale`);
  } else {
    warn("daemon not running — lzo daemon start");
  }
  try {
    const backlog = (await readdir(paths.spool())).filter((f) =>
      f.startsWith("evt-"),
    ).length;
    (backlog > 200 ? warn : info)(`spool backlog: ${backlog} event(s)`);
  } catch {
    /* spool missing — init not run */
  }
}
