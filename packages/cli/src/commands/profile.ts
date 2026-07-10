/** `lzo profile` — Claude account profiles (auth only, per your spec). */
import { Command } from "commander";

import { addProfile, loadConfig, removeProfile } from "@lazyobserver/core";

import { info, ok } from "../ui.js";

export function profileCommand(): Command {
  const cmd = new Command("profile").description(
    "manage Claude account profiles (auth only)",
  );

  cmd
    .command("add <name>")
    .requiredOption(
      "--config-dir <path>",
      "Claude config dir for this account (e.g. ~/.claude)",
    )
    .description("register a profile pointing at a Claude config dir")
    .action(async (name: string, opts: { configDir: string }) => {
      const p = await addProfile(name, opts.configDir);
      ok(`profile "${p.name}" → ${p.claudeConfigDir}`);
    });

  cmd
    .command("list")
    .description("list profiles")
    .action(async () => {
      const cfg = await loadConfig();
      if (cfg.profiles.length === 0) {
        info("no profiles yet — lzo profile add work --config-dir ~/.claude");
        return;
      }
      for (const p of cfg.profiles) info(`${p.name} → ${p.claudeConfigDir}`);
    });

  cmd
    .command("remove <name>")
    .description("remove a profile (fails if pinned by a workspace)")
    .action(async (name: string) => {
      await removeProfile(name);
      ok(`profile "${name}" removed`);
    });

  return cmd;
}
