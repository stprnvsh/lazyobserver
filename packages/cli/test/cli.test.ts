/**
 * CLI integration tests — run the BUILT binary the way a user would.
 * Requirements encoded here:
 *  - `lzo init --no-model` sets up dirs + config + all LanceDB tables.
 *  - `lzo profile add` / `workspace add` persist and print correctly.
 *  - `lzo doctor --no-model` exits 0 on a healthy install.
 *  - `lzo status` reports row counts for every table.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

const cliDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js",
);

let tmp: string;

function lzo(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return run("node", [cliDist, ...args], {
    env: { ...process.env, LAZYOBSERVER_HOME: tmp, NO_COLOR: "1" },
  });
}

beforeAll(() => {
  if (!existsSync(cliDist)) {
    throw new Error("CLI not built — run `npm run build` before tests");
  }
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-cli-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("lzo end-to-end", () => {
  it("init creates home, config and all tables", { timeout: 120_000 }, async () => {
    const { stdout } = await lzo(["init", "--no-model"]);
    expect(stdout).toMatch(/directories ready/);
    expect(stdout).toMatch(/LanceDB store ready \(9 tables\)/);
    expect(existsSync(path.join(tmp, "config.json"))).toBe(true);
    expect(existsSync(path.join(tmp, "db"))).toBe(true);
  });

  it("profile + workspace management persists", { timeout: 60_000 }, async () => {
    await lzo(["profile", "add", "work", "--config-dir", "~/.claude"]);
    const { stdout: wsOut } = await lzo([
      "workspace",
      "add",
      "transcality",
      "--repos",
      `${tmp},${tmp}`,
      "--profile",
      "work",
    ]);
    expect(wsOut).toMatch(/workspace "transcality" — 1 repo\(s\), profile: work/);

    const { stdout: listOut } = await lzo(["workspace", "list"]);
    expect(listOut).toContain("transcality");
    expect(listOut).toContain("[profile: work]");
  });

  it("doctor passes on a healthy install (model skipped)", { timeout: 120_000 }, async () => {
    const { stdout } = await lzo(["doctor", "--no-model"]);
    expect(stdout).toMatch(/all checks passed/);
  });

  it("status reports row counts for every table", { timeout: 60_000 }, async () => {
    const { stdout } = await lzo(["status"]);
    for (const t of [
      "events",
      "messages",
      "sessions",
      "tasks",
      "codebase_memory",
      "memory_chunks",
      "daily_memory",
      "decisions",
      "artifacts",
    ]) {
      expect(stdout).toContain(t);
    }
  });

  it("rejects removing a pinned profile (fail-closed)", { timeout: 60_000 }, async () => {
    // must exit non-zero AND explain why (message goes to the CLI's output)
    const err = (await lzo(["profile", "remove", "work"]).then(
      () => null,
      (e: Error & { stdout?: string; stderr?: string }) => e,
    ))!;
    expect(err).not.toBeNull();
    expect(`${err.stdout}${err.stderr}`).toMatch(/pinned/i);
  });
});
