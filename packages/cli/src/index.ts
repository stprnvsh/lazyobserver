#!/usr/bin/env node
/**
 * lazyobserver (lzo) — local-first observability, memory and reporting for
 * Claude Code work. M1: foundation (config, store, embeddings, init/doctor).
 */
import { Command } from "commander";

import { askCommand } from "./commands/ask.js";
import { briefCommand } from "./commands/brief.js";
import { captureCommand } from "./commands/capture.js";
import { daemonCommand } from "./commands/daemon.js";
import { doctorCommand } from "./commands/doctor.js";
import { eodCommand } from "./commands/eod.js";
import { importClaudeMemory } from "./commands/importcmd.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { profileCommand } from "./commands/profile.js";
import { reportCommand, webCommand } from "./commands/report.js";
import { statusCommand } from "./commands/status.js";
import { connectCommand, tasksCommand, workCommand } from "./commands/tasks.js";
import { workspaceCommand } from "./commands/workspace.js";
import { fail } from "./ui.js";

const program = new Command();

program
  .name("lzo")
  .description(
    "lazyobserver — record everything you and your agents do, remember it, report it",
  )
  .version("0.1.0");

program
  .command("init")
  .description("set up ~/.lazyobserver (dirs, config, store, embeddings)")
  .option("--no-model", "skip embedding-model warmup")
  .action(async (opts: { model: boolean }) => initCommand(opts));

program
  .command("doctor")
  .description("verify the installation end-to-end")
  .option("--no-model", "skip the embedding-model check")
  .action(async (opts: { model: boolean }) => doctorCommand(opts));

program
  .command("status")
  .description("config summary + store row counts")
  .action(async () => statusCommand());

program
  .command("brief")
  .description("print the SessionStart context brief (used by the hook)")
  .option("--hook", "hook mode: read hook JSON from stdin, never fail")
  .action(async (opts: { hook?: boolean }) => briefCommand({ hook: !!opts.hook }));

program
  .command("ask <question>")
  .description("recall from memory, journals and conversations")
  .option("-k <n>", "results per source", "5")
  .action(async (question: string, opts: { k: string }) => askCommand(question, opts));

program
  .command("eod")
  .description("distill today's work into memory + day doc (+ MEMORY.md projections)")
  .option("--date <date>", "YYYY-MM-DD (default today)")
  .option("--offline", "mechanical day doc, no LLM call")
  .action(async (opts: { date?: string; offline?: boolean }) => eodCommand(opts));

const importCmd = program
  .command("import")
  .description("import external data");
importCmd
  .command("claude-memory")
  .description("migrate existing Claude auto-memory markdown into the store")
  .action(async () => importClaudeMemory());

program
  .command("report")
  .description("daily observability report (tasks, time, tokens, decisions)")
  .option("--date <date>", "YYYY-MM-DD (default today)")
  .option("--export <fmt>", "write to ~/.lazyobserver/exports (md|html|json)")
  .action(async (opts: { date?: string; export?: string }) => reportCommand(opts));

program
  .command("web")
  .description("open the local dashboard (today/tasks/journal/search + exports)")
  .option("--port <port>", "port", "43180")
  .action(async (opts: { port: string }) => webCommand(opts));

program.addCommand(profileCommand());
program.addCommand(workspaceCommand());
program.addCommand(captureCommand());
program.addCommand(daemonCommand());
program.addCommand(mcpCommand());
program.addCommand(connectCommand());
program.addCommand(tasksCommand());
program.addCommand(workCommand());

program.parseAsync().catch((err: unknown) => {
  fail((err as Error).message);
  process.exitCode = 1;
});
