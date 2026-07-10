/**
 * Requirements encoded here:
 *  - Config persists to $LAZYOBSERVER_HOME/config.json and round-trips.
 *  - Profiles are auth-only: name -> claude config dir; unique by name.
 *  - Workspaces: named folder sets; a repo may belong to MULTIPLE workspaces;
 *    each workspace can pin exactly one profile (company code never runs on a
 *    personal account).
 *  - Repo paths are normalized (absolute, no trailing slash) so event
 *    attribution matches transcript cwd paths.
 *  - Removing a profile that a workspace pins must fail loudly (fail-closed),
 *    not silently orphan the workspace.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addProfile,
  addRepoToWorkspace,
  addWorkspace,
  loadConfig,
  removeProfile,
  saveConfig,
  setCurrentWorkspace,
} from "../src/config.js";
import { paths } from "../src/paths.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lazyobs-test-"));
  process.env.LAZYOBSERVER_HOME = tmp;
});

afterEach(() => {
  delete process.env.LAZYOBSERVER_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("config persistence", () => {
  it("creates a default config on first load and round-trips edits", async () => {
    const cfg = await loadConfig();
    expect(cfg.profiles).toEqual([]);
    expect(cfg.workspaces).toEqual([]);

    cfg.settings.redaction.enabled = true;
    await saveConfig(cfg);

    const again = await loadConfig();
    expect(again.settings.redaction.enabled).toBe(true);
    expect(paths.configFile().startsWith(tmp)).toBe(true);
  });
});

describe("profiles", () => {
  it("adds a profile with a claude config dir and rejects duplicates", async () => {
    await addProfile("work", "~/.claude");
    await expect(addProfile("work", "~/.claude-2")).rejects.toThrow(/exists/i);

    const cfg = await loadConfig();
    expect(cfg.profiles).toHaveLength(1);
    expect(cfg.profiles[0].name).toBe("work");
    // ~ must be expanded so the daemon can watch the dir directly
    expect(cfg.profiles[0].claudeConfigDir.startsWith("/")).toBe(true);
  });

  it("refuses to remove a profile pinned by a workspace", async () => {
    await addProfile("work", "~/.claude");
    await addWorkspace("transcality", { profile: "work" });
    await expect(removeProfile("work")).rejects.toThrow(/pinned/i);
  });
});

describe("workspaces", () => {
  it("adds workspaces with repos; a repo can belong to multiple workspaces", async () => {
    await addProfile("work", "~/.claude");
    await addWorkspace("transcality", {
      profile: "work",
      repos: ["/tmp/repo-a/", "/tmp/repo-b"],
    });
    await addWorkspace("side", { repos: ["/tmp/repo-a"] });

    const cfg = await loadConfig();
    const t = cfg.workspaces.find((w) => w.name === "transcality")!;
    const s = cfg.workspaces.find((w) => w.name === "side")!;
    // normalized: absolute, no trailing slash
    expect(t.repos).toContain("/tmp/repo-a");
    expect(t.repos).toContain("/tmp/repo-b");
    expect(s.repos).toContain("/tmp/repo-a");
    expect(t.profile).toBe("work");
  });

  it("pinning an unknown profile fails", async () => {
    await expect(addWorkspace("w", { profile: "ghost" })).rejects.toThrow(
      /unknown profile/i,
    );
  });

  it("adds repos to an existing workspace idempotently", async () => {
    await addWorkspace("w", {});
    await addRepoToWorkspace("w", "/tmp/x");
    await addRepoToWorkspace("w", "/tmp/x/");
    const cfg = await loadConfig();
    expect(cfg.workspaces[0].repos).toEqual(["/tmp/x"]);
  });

  it("tracks a current workspace and validates it exists", async () => {
    await addWorkspace("w", {});
    await setCurrentWorkspace("w");
    expect((await loadConfig()).currentWorkspace).toBe("w");
    await expect(setCurrentWorkspace("nope")).rejects.toThrow(/unknown/i);
  });
});
