/**
 * `lzo doctor` — verify the installation end-to-end and report M2 readiness.
 * Every check is real (no vibes): it opens the DB, loads the model, looks for
 * the Claude transcript roots the capture layer (M2) will watch.
 */
import { access, constants, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  allDirs,
  Embedder,
  EMBEDDING_DIMENSIONS,
  loadConfig,
  Store,
  TABLES,
} from "@lazyobserver/core";
import {
  HOOK_MARKER,
  hookScriptPath,
  isAlive,
  readDaemonState,
} from "@lazyobserver/daemon";

import { fail, heading, info, ok, warn } from "../ui.js";

const run = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorOptions {
  /** skip the (slow) embedding-model check */
  model: boolean;
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  let failures = 0;

  heading("environment");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else {
    fail(`node ${process.versions.node} (need >= 20)`);
    failures++;
  }

  heading("home & config");
  for (const dir of allDirs()) {
    if (await exists(dir)) ok(dir);
    else {
      fail(`${dir} missing — run: lzo init`);
      failures++;
    }
  }
  let cfgProfiles: { name: string; claudeConfigDir: string }[] = [];
  try {
    const cfg = await loadConfig();
    cfgProfiles = cfg.profiles;
    ok(
      `config valid — ${cfg.profiles.length} profile(s), ${cfg.workspaces.length} workspace(s)` +
        (cfg.currentWorkspace ? `, current: ${cfg.currentWorkspace}` : ""),
    );
    for (const ws of cfg.workspaces) {
      if (ws.profile && !cfg.profiles.some((p) => p.name === ws.profile)) {
        fail(`workspace "${ws.name}" pins unknown profile "${ws.profile}"`);
        failures++;
      }
      for (const repo of ws.repos) {
        if (!(await exists(repo))) {
          warn(`workspace "${ws.name}": repo path missing: ${repo}`);
        }
      }
    }
  } catch (err) {
    fail(`config invalid: ${(err as Error).message}`);
    failures++;
  }

  heading("store");
  try {
    const store = await Store.open();
    const names = await store.tableNames();
    const missing = Object.values(TABLES).filter((t) => !names.includes(t));
    if (missing.length === 0) ok(`LanceDB ok — ${names.length} tables`);
    else {
      fail(`missing tables: ${missing.join(", ")} — run: lzo init`);
      failures++;
    }
  } catch (err) {
    fail(`LanceDB unreachable: ${(err as Error).message}`);
    failures++;
  }

  heading("local embeddings");
  if (opts.model) {
    try {
      const embedder = new Embedder();
      const started = Date.now();
      const [v] = await embedder.embed(["doctor check"]);
      if (v.length === EMBEDDING_DIMENSIONS) {
        ok(
          `model produces ${EMBEDDING_DIMENSIONS}-dim vectors (${Date.now() - started} ms, on-device)`,
        );
      } else {
        fail(`model returned ${v.length} dims (expected ${EMBEDDING_DIMENSIONS})`);
        failures++;
      }
    } catch (err) {
      fail(`embedding model failed: ${(err as Error).message}`);
      failures++;
    }
  } else {
    info("skipped (--no-model)");
  }

  heading("capture");
  try {
    const { stdout } = await run("claude", ["--version"]);
    ok(`claude CLI: ${stdout.trim()}`);
  } catch {
    warn("claude CLI not found on PATH");
  }
  const transcriptRoots = new Set<string>([
    path.join(os.homedir(), ".claude", "projects"),
    ...cfgProfiles.map((p) => path.join(p.claudeConfigDir, "projects")),
  ]);
  for (const root of transcriptRoots) {
    if (await exists(root)) ok(`transcript root: ${root}`);
    else warn(`transcript root not found yet: ${root}`);
  }

  // hook script + per-profile settings wiring
  if (await exists(hookScriptPath())) ok(`hook script: ${hookScriptPath()}`);
  else {
    warn(`hook script missing — run: lzo capture install`);
  }
  for (const p of cfgProfiles) {
    const settingsFile = path.join(p.claudeConfigDir, "settings.json");
    try {
      const raw = await readFile(settingsFile, "utf8");
      if (raw.includes(HOOK_MARKER)) ok(`profile "${p.name}": hooks installed`);
      else warn(`profile "${p.name}": hooks NOT installed — lzo capture install`);
      if (raw.includes("OTEL_EXPORTER_OTLP_ENDPOINT"))
        ok(`profile "${p.name}": telemetry env present`);
      else warn(`profile "${p.name}": telemetry env missing`);
    } catch {
      warn(`profile "${p.name}": no settings.json at ${settingsFile}`);
    }
  }

  // daemon liveness
  const state = await readDaemonState();
  if (state && isAlive(state.pid) && Date.now() - state.lastBeat < 15_000) {
    ok(`daemon running (pid ${state.pid})`);
  } else {
    warn("daemon not running — lzo daemon start");
  }

  heading("verdict");
  if (failures === 0) ok("all checks passed");
  else {
    fail(`${failures} check(s) failed`);
    process.exitCode = 1;
  }
}
