/**
 * Daemon main loop — the ONLY LanceDB writer (local-fs concurrent writes are
 * unsafe; readers are MVCC-safe).
 *
 *  - pid lock (refuses a second instance — single-writer invariant)
 *  - spool sweep     every 2s   (hook events -> events)
 *  - transcript sweep every 3s  (appended lines -> messages/sessions)
 *  - writer flush    every 2s   (batched mergeInserts)
 *  - heartbeat       every 5s   (state file `lzo status` reads)
 *  - maintenance     every 5min (optimize -> folds rows into FTS indexes;
 *                                creates FTS indexes once tables have data)
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  allDirs,
  Embedder,
  loadConfig,
  paths,
  Store,
  type Config,
} from "@lazyobserver/core";

import { OTLP_PORT } from "./capture/install.js";
import { Writer } from "./ingest/writer.js";
import { startOtlpServer } from "./otlp.js";
import { processSpoolOnce } from "./spool.js";
import { TranscriptTailer } from "./transcript/tailer.js";

const pidFile = (): string => path.join(paths.home(), "daemon.pid");
const stateFile = (): string => path.join(paths.home(), "daemon.state.json");

export interface DaemonState {
  pid: number;
  startedAt: number;
  lastBeat: number;
  otlpPort: number;
  counters: {
    events: number;
    messages: number;
    sessions: number;
    flushes: number;
    spoolSweeps: number;
    transcriptLines: number;
    otlpEvents: number;
    filesTracked: number;
  };
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(stateFile(), "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<void> {
  try {
    const existing = Number(await readFile(pidFile(), "utf8"));
    if (existing && isAlive(existing)) {
      throw new Error(`daemon already running (pid ${existing})`);
    }
  } catch (err) {
    if ((err as Error).message?.includes("already running")) throw err;
    /* stale or missing pidfile — take over */
  }
  await writeFile(pidFile(), String(process.pid), "utf8");
}

export async function runDaemon(): Promise<void> {
  for (const dir of allDirs()) await mkdir(dir, { recursive: true });
  await acquireLock();

  const store = await Store.open();
  await store.ensureTables();
  const embedder = new Embedder();
  await embedder.embed(["daemon warmup"]); // load the model before ingest
  const writer = new Writer(store, (texts) => embedder.embed(texts));

  let cfg: Config = await loadConfig();
  const roots = cfg.profiles.map((p) => ({
    profile: p.name,
    dir: path.join(p.claudeConfigDir, "projects"),
  }));
  const tailer = new TranscriptTailer(roots, writer, () => cfg);
  await tailer.loadState();

  let otlpEvents = 0;
  const otlp = await startOtlpServer(writer, OTLP_PORT, (n) => {
    otlpEvents += n;
  });

  let spoolSweeps = 0;
  let ftsCreated = false;
  let stopping = false;

  const beat = async (): Promise<void> => {
    const state: DaemonState = {
      pid: process.pid,
      startedAt,
      lastBeat: Date.now(),
      otlpPort: OTLP_PORT,
      counters: {
        ...writer.counters,
        spoolSweeps,
        transcriptLines: tailer.counters.linesParsed,
        otlpEvents,
        filesTracked: tailer.counters.filesTracked,
      },
    };
    await writeFile(stateFile(), JSON.stringify(state, null, 2), "utf8");
  };

  const startedAt = Date.now();
  console.log(
    `[daemon] pid=${process.pid} home=${paths.home()} otlp=127.0.0.1:${OTLP_PORT} roots=${roots
      .map((r) => r.dir)
      .join(", ")}`,
  );

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void>): void => {
    let busy = false;
    timers.push(
      setInterval(() => {
        if (busy || stopping) return;
        busy = true;
        fn()
          .catch((err) => console.error("[daemon]", err))
          .finally(() => (busy = false));
      }, ms),
    );
  };

  every(2_000, async () => {
    spoolSweeps++;
    await processSpoolOnce(writer);
  });
  every(3_000, async () => {
    cfg = await loadConfig(); // pick up new workspaces/repos without restart
    await tailer.sweep();
  });
  every(2_000, async () => writer.flush());
  every(5_000, beat);
  every(300_000, async () => {
    const { optimized } = await writer.maintain();
    if (optimized && !ftsCreated) {
      try {
        await store.createFtsIndexes();
        ftsCreated = true;
        console.log("[daemon] FTS indexes created");
      } catch (err) {
        console.error("[daemon] FTS index creation deferred:", err);
      }
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[daemon] ${signal} — flushing and exiting`);
    for (const t of timers) clearInterval(t);
    otlp.close();
    try {
      await writer.flush();
      await tailer.saveState();
      await beat();
      await unlink(pidFile());
    } catch (err) {
      console.error("[daemon] shutdown error", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await beat();
}
