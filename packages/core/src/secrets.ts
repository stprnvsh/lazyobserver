/**
 * Local-only secret storage for integration tokens (ClickUp etc.).
 *
 * macOS: the login Keychain via the `security` CLI (never leaves the device).
 * Fallback (non-darwin / tests via LAZYOBSERVER_SECRETS_FILE): a 0600 JSON
 * file under the lazyobserver home.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { paths } from "./paths.js";

const run = promisify(execFile);
const SERVICE_PREFIX = "lazyobserver.";

function fileBackend(): string | null {
  if (process.env.LAZYOBSERVER_SECRETS_FILE)
    return process.env.LAZYOBSERVER_SECRETS_FILE;
  if (process.platform !== "darwin")
    return path.join(paths.home(), "secrets.json");
  return null;
}

async function readSecretsFile(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setSecret(name: string, value: string): Promise<void> {
  const file = fileBackend();
  if (file) {
    const all = await readSecretsFile(file);
    all[name] = value;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(all, null, 2), "utf8");
    await chmod(file, 0o600);
    return;
  }
  await run("security", [
    "add-generic-password",
    "-a",
    "lazyobserver",
    "-s",
    SERVICE_PREFIX + name,
    "-w",
    value,
    "-U", // update if exists
  ]);
}

export async function getSecret(name: string): Promise<string | null> {
  const file = fileBackend();
  if (file) {
    const all = await readSecretsFile(file);
    return all[name] ?? null;
  }
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-a",
      "lazyobserver",
      "-s",
      SERVICE_PREFIX + name,
      "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
