/**
 * `lzo redaction` — the secret-scrubbing toggle (OFF by default; everything
 * is local-first, so this is opt-in defence-in-depth / safe-export mode).
 *
 * Applies at CAPTURE time (event payloads, transcript messages, memory
 * writes) and EXPORT time (reports, day docs). Rows captured BEFORE enabling
 * stay as they were — redaction is not retroactive.
 */
import { loadConfig, saveConfig } from "@lazyobserver/core";
import { Command } from "commander";

import { info, ok, warn } from "../ui.js";

export function redactionCommand(): Command {
  const cmd = new Command("redaction").description(
    "secret scrubbing for captures and exports (opt-in)",
  );

  cmd
    .command("status", { isDefault: true })
    .description("show whether redaction is enabled")
    .action(async () => {
      const cfg = await loadConfig();
      if (cfg.settings.redaction.enabled) ok("redaction: ON (captures + exports scrubbed)");
      else info("redaction: off (default — data never leaves this machine anyway)");
    });

  cmd
    .command("on")
    .description("enable scrubbing of new captures and exports")
    .action(async () => {
      const cfg = await loadConfig();
      cfg.settings.redaction.enabled = true;
      await saveConfig(cfg);
      ok("redaction ON — applies to NEW captures and exports");
      warn("existing store rows are unchanged (redaction is not retroactive)");
      info("patterns: AWS keys, GitHub/Slack/ClickUp/OpenAI tokens, JWTs, Bearer");
      info("headers, URL credentials, private-key blocks, password/token assignments");
    });

  cmd
    .command("off")
    .description("disable scrubbing")
    .action(async () => {
      const cfg = await loadConfig();
      cfg.settings.redaction.enabled = false;
      await saveConfig(cfg);
      ok("redaction off");
    });

  return cmd;
}
