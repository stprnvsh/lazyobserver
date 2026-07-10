/**
 * `lzo mcp` — register/unregister the lazyobserver MCP server with Claude
 * Code (user scope: every project, every surface).
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { Command } from "commander";

import { fail, info, ok } from "../ui.js";

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);

export function mcpEntry(): string {
  return require_.resolve("@lazyobserver/mcp");
}

export function mcpCommand(): Command {
  const cmd = new Command("mcp").description(
    "manage the lazyobserver MCP server registration",
  );

  cmd
    .command("install")
    .description("register with Claude Code (user scope, all projects)")
    .action(async () => {
      const config = JSON.stringify({
        type: "stdio",
        command: process.execPath,
        args: [mcpEntry()],
      });
      // re-register idempotently
      await run("claude", ["mcp", "remove", "--scope", "user", "lazyobserver"]).catch(
        () => undefined,
      );
      try {
        await run("claude", [
          "mcp",
          "add-json",
          "--scope",
          "user",
          "lazyobserver",
          config,
        ]);
        ok("MCP server registered (user scope)");
        info(
          "new sessions get: memory_search, work_recall, memory_save, journal_note, daily_brief",
        );
      } catch (err) {
        fail(`claude mcp add-json failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command("uninstall")
    .description("remove the registration")
    .action(async () => {
      try {
        await run("claude", ["mcp", "remove", "--scope", "user", "lazyobserver"]);
        ok("MCP server unregistered");
      } catch {
        info("was not registered");
      }
    });

  return cmd;
}
