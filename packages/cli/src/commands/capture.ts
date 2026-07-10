/** `lzo capture` — install/remove the Claude Code hooks + OTel wiring. */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { installCapture, uninstallCapture } from "@lazyobserver/daemon";

import { heading, info, ok, warn } from "../ui.js";

/** absolute path of the built CLI entry (dist/index.js) for the brief hook */
function cliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.js");
}

export function captureCommand(): Command {
  const cmd = new Command("capture").description(
    "manage session capture (hooks + telemetry wiring)",
  );

  cmd
    .command("install")
    .description(
      "write the hook script and wire hooks + OTel env into every profile's settings.json (non-destructive, backed up)",
    )
    .action(async () => {
      const report = await installCapture({ cliEntry: cliEntry() });
      ok(`hook script: ${report.hookScript}`);
      if (report.briefScript) ok(`brief script: ${report.briefScript}`);
      for (const p of report.profiles) {
        if (p.changed) {
          ok(`profile "${p.name}": ${p.settingsFile} updated`);
          if (p.backup) info(`  backup: ${p.backup}`);
        } else {
          info(`profile "${p.name}": already installed`);
        }
        for (const c of p.envConflicts) {
          warn(
            `  env conflict on ${c.key}: kept "${c.existing}" (wanted "${c.wanted}") — token/cost telemetry may not reach the daemon`,
          );
        }
      }
      heading("note");
      info("hooks apply to NEW sessions — running sessions keep old settings");
      info("start the collector: lzo daemon start");
    });

  cmd
    .command("uninstall")
    .description("remove exactly our hooks + env keys from every profile")
    .action(async () => {
      const results = await uninstallCapture();
      for (const r of results) {
        if (r.changed) ok(`profile "${r.name}": lazyobserver hooks removed`);
        else info(`profile "${r.name}": nothing to remove`);
      }
    });

  return cmd;
}
