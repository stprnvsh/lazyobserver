/**
 * `lzo init` — one-time setup:
 *   1. create the ~/.lazyobserver directory layout
 *   2. write a default config if none exists
 *   3. create all LanceDB tables
 *   4. warm the local embedding model (downloads once, then offline)
 *
 * M2 will extend this with hook installation + daemon registration; M3 with
 * MCP registration. Kept idempotent — safe to re-run after upgrades.
 */
import { mkdir } from "node:fs/promises";

import {
  allDirs,
  Embedder,
  EMBEDDING_DIMENSIONS,
  loadConfig,
  paths,
  saveConfig,
  Store,
} from "@lazyobserver/core";

import { heading, info, ok, warn } from "../ui.js";

export interface InitOptions {
  /** skip the embedding-model warmup (e.g. offline setup) */
  model: boolean;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  heading(`lazyobserver init → ${paths.home()}`);

  for (const dir of allDirs()) {
    await mkdir(dir, { recursive: true });
  }
  ok(`directories ready (${allDirs().length})`);

  // creates the file with defaults when absent; keeps existing config as-is
  const cfg = await loadConfig();
  await saveConfig(cfg);
  ok(`config at ${paths.configFile()}`);

  const store = await Store.open();
  await store.ensureTables();
  ok(`LanceDB store ready (${(await store.tableNames()).length} tables)`);
  info(
    "FTS indexes are created on first ingest and maintained by the daemon (M2).",
  );

  if (opts.model) {
    info("warming local embedding model (first run downloads ~25 MB) ...");
    const embedder = new Embedder();
    const [v] = await embedder.embed(["lazyobserver init warmup"]);
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding warmup returned ${v.length} dims, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    ok(`local embeddings ready (${EMBEDDING_DIMENSIONS} dims, on-device)`);
  } else {
    warn("model warmup skipped (--no-model)");
  }

  heading("next steps");
  info("lzo profile add work --config-dir ~/.claude");
  info("lzo workspace add <name> --repos <path,...> --profile work");
  info("lzo doctor");
}
