/**
 * Capture install/uninstall — file IO around the pure settings merger.
 *
 * For every configured profile (each has its own Claude config dir):
 *   1. back up settings.json (timestamped, once per run)
 *   2. merge our hooks + OTel env in, non-destructively
 *   3. write the hook script to ~/.lazyobserver/bin/lazyobserver-hook.sh
 */
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, paths } from "@lazyobserver/core";

import { HOOK_SCRIPT } from "./script.js";
import { mergeSettings, unmergeSettings } from "./settings.js";

export const OTLP_PORT = 43179;

export function hookScriptPath(): string {
  return path.join(paths.home(), "bin", "lazyobserver-hook.sh");
}

export function briefScriptPath(): string {
  return path.join(paths.home(), "bin", "lazyobserver-brief.sh");
}

/**
 * The SessionStart brief wrapper: pins the node binary + CLI entry that were
 * live at install time, so hooks work regardless of the shell's PATH/nvm
 * state. Always exits 0 — a broken brief must never block a session.
 */
export function briefScript(nodePath: string, cliEntry: string): string {
  return `#!/bin/sh
# lazyobserver SessionStart brief — prints session context to stdout. Never fails.
"${nodePath}" "${cliEntry}" brief --hook 2>/dev/null
exit 0
`;
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // malformed settings must NOT be clobbered silently
  }
}

export interface InstallReport {
  hookScript: string;
  briefScript: string | null;
  profiles: {
    name: string;
    settingsFile: string;
    changed: boolean;
    backup: string | null;
    envConflicts: { key: string; existing: string; wanted: string }[];
  }[];
}

export interface InstallOptions {
  /** absolute CLI entry (dist/index.js) — enables the SessionStart brief */
  cliEntry?: string;
}

export async function installCapture(
  opts: InstallOptions = {},
): Promise<InstallReport> {
  const cfg = await loadConfig();
  if (cfg.profiles.length === 0) {
    throw new Error(
      "No profiles configured. Run: lzo profile add work --config-dir ~/.claude",
    );
  }

  const script = hookScriptPath();
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, HOOK_SCRIPT, "utf8");
  await chmod(script, 0o755);

  let brief: string | null = null;
  if (opts.cliEntry) {
    brief = briefScriptPath();
    await writeFile(brief, briefScript(process.execPath, opts.cliEntry), "utf8");
    await chmod(brief, 0o755);
  }

  const report: InstallReport = { hookScript: script, briefScript: brief, profiles: [] };
  for (const profile of cfg.profiles) {
    const settingsFile = path.join(profile.claudeConfigDir, "settings.json");
    const current = await readSettings(settingsFile);
    const { settings, changed, envConflicts } = mergeSettings(
      current,
      script,
      OTLP_PORT,
      brief ?? undefined,
    );
    let backup: string | null = null;
    if (changed) {
      try {
        backup = `${settingsFile}.lazyobserver-backup-${Date.now()}`;
        await copyFile(settingsFile, backup);
      } catch {
        backup = null; // no pre-existing file to back up
      }
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(
        settingsFile,
        JSON.stringify(settings, null, 2) + "\n",
        "utf8",
      );
    }
    report.profiles.push({
      name: profile.name,
      settingsFile,
      changed,
      backup,
      envConflicts,
    });
  }
  return report;
}

export async function uninstallCapture(): Promise<
  { name: string; settingsFile: string; changed: boolean }[]
> {
  const cfg = await loadConfig();
  const results: { name: string; settingsFile: string; changed: boolean }[] =
    [];
  for (const profile of cfg.profiles) {
    const settingsFile = path.join(profile.claudeConfigDir, "settings.json");
    const current = await readSettings(settingsFile);
    const { settings, changed } = unmergeSettings(current, OTLP_PORT);
    if (changed) {
      await copyFile(
        settingsFile,
        `${settingsFile}.lazyobserver-backup-${Date.now()}`,
      );
      await writeFile(
        settingsFile,
        JSON.stringify(settings, null, 2) + "\n",
        "utf8",
      );
    }
    results.push({ name: profile.name, settingsFile, changed });
  }
  return results;
}
