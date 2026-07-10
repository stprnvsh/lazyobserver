#!/usr/bin/env node
/**
 * lazyobserver-daemon — capture service. `run` executes in the foreground;
 * the CLI (`lzo daemon start`) spawns it detached, and launchd keeps it
 * alive across reboots once installed.
 */
export { runDaemon, readDaemonState, isAlive, type DaemonState } from "./main.js";
export {
  installCapture,
  uninstallCapture,
  hookScriptPath,
  briefScriptPath,
  OTLP_PORT,
} from "./capture/install.js";
export { mergeSettings, unmergeSettings, HOOK_EVENTS, otelEnv } from "./capture/settings.js";
export { HOOK_SCRIPT, HOOK_MARKER } from "./capture/script.js";
export {
  queueMemWrite,
  embeddingText,
  isMemFile,
  type MemWrite,
  type MemTable,
} from "./memwrite.js";
export { parseTranscriptLine, type ParsedMessage } from "./transcript/parser.js";

const arg = process.argv[2];
if (arg === "run") {
  const { runDaemon } = await import("./main.js");
  runDaemon().catch((err) => {
    console.error("[daemon] fatal:", err);
    process.exit(1);
  });
}
