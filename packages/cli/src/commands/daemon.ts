/**
 * `lzo daemon` — lifecycle of the capture daemon (the single LanceDB writer).
 * start/stop manage a detached process; install-launchd makes it survive
 * reboots (KeepAlive).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { paths } from "@lazyobserver/core";
import { isAlive, readDaemonState } from "@lazyobserver/daemon";
import { Command } from "commander";

import { fail, heading, info, ok, warn } from "../ui.js";

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);

const PLIST_LABEL = "com.lazyobserver.daemon";

function daemonEntry(): string {
  return require_.resolve("@lazyobserver/daemon");
}

function plistPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${PLIST_LABEL}.plist`,
  );
}

async function currentPid(): Promise<number | null> {
  try {
    const pid = Number(
      await readFile(path.join(paths.home(), "daemon.pid"), "utf8"),
    );
    return pid && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function daemonCommand(): Command {
  const cmd = new Command("daemon").description(
    "manage the capture daemon (single writer)",
  );

  cmd
    .command("start")
    .description("start the daemon in the background")
    .action(async () => {
      if (await currentPid()) {
        info("daemon already running");
        return;
      }
      await mkdir(paths.logs(), { recursive: true });
      const log = await open(path.join(paths.logs(), "daemon.log"), "a");
      const child = spawn(process.execPath, [daemonEntry(), "run"], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.env,
      });
      child.unref();
      await log.close();
      // give it a moment to acquire the lock and warm up
      await new Promise((r) => setTimeout(r, 2500));
      const pid = await currentPid();
      if (pid) ok(`daemon running (pid ${pid}) — log: ${paths.logs()}/daemon.log`);
      else {
        fail("daemon did not come up — check the log");
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("stop the daemon")
    .action(async () => {
      const pid = await currentPid();
      if (!pid) {
        info("daemon not running");
        return;
      }
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 20 && isAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (isAlive(pid)) {
        warn("daemon still alive after SIGTERM");
        process.exitCode = 1;
      } else ok("daemon stopped");
    });

  cmd
    .command("status")
    .description("daemon health + ingest counters")
    .action(async () => {
      const pid = await currentPid();
      const state = await readDaemonState();
      if (!pid) {
        warn("daemon: not running");
        return;
      }
      ok(`daemon: running (pid ${pid})`);
      if (state) {
        const up = Math.round((Date.now() - state.startedAt) / 1000);
        const fresh = Date.now() - state.lastBeat < 15_000;
        info(`uptime: ${up}s — heartbeat ${fresh ? "fresh" : "STALE"}`);
        info(`otlp: 127.0.0.1:${state.otlpPort}`);
        const c = state.counters;
        info(
          `ingested: ${c.events} events, ${c.messages} messages, ${c.sessions} session upserts`,
        );
        info(
          `transcripts: ${c.filesTracked} files tracked, ${c.transcriptLines} lines parsed`,
        );
        info(`otlp events: ${c.otlpEvents} — flushes: ${c.flushes}`);
      }
    });

  cmd
    .command("install-launchd")
    .description("keep the daemon alive across reboots (macOS launchd)")
    .action(async () => {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonEntry()}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.logs()}/daemon.log</string>
  <key>StandardErrorPath</key><string>${paths.logs()}/daemon.log</string>
</dict>
</plist>
`;
      await mkdir(path.dirname(plistPath()), { recursive: true });
      await writeFile(plistPath(), plist, "utf8");
      try {
        await run("launchctl", ["unload", plistPath()]).catch(() => undefined);
        await run("launchctl", ["load", "-w", plistPath()]);
        ok(`launchd agent loaded: ${plistPath()}`);
        info("daemon now starts at login and restarts if it dies");
      } catch (err) {
        fail(`launchctl failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command("uninstall-launchd")
    .description("remove the launchd agent")
    .action(async () => {
      try {
        await run("launchctl", ["unload", plistPath()]).catch(() => undefined);
        await unlink(plistPath());
        ok("launchd agent removed");
      } catch {
        info("no launchd agent installed");
      }
      heading("note");
      info("a running daemon keeps running — lzo daemon stop to end it");
    });

  return cmd;
}
