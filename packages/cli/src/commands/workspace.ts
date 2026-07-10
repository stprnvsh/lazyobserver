/**
 * `lzo workspace` — named sets of repo folders. A repo may belong to several
 * workspaces; a workspace may pin one profile (company code never runs on a
 * personal account).
 */
import { Command } from "commander";

import {
  addRepoToWorkspace,
  addWorkspace,
  loadConfig,
  removeWorkspace,
  setCurrentWorkspace,
} from "@lazyobserver/core";

import { info, ok } from "../ui.js";

export function workspaceCommand(): Command {
  const cmd = new Command("workspace").description(
    "manage workspaces (sets of repo folders)",
  );

  cmd
    .command("add <name>")
    .option("--repos <paths>", "comma-separated repo folder paths")
    .option("--profile <name>", "pin a profile to this workspace")
    .description("create a workspace")
    .action(
      async (name: string, opts: { repos?: string; profile?: string }) => {
        const ws = await addWorkspace(name, {
          repos: opts.repos ? opts.repos.split(",").map((s) => s.trim()) : [],
          profile: opts.profile,
        });
        ok(
          `workspace "${ws.name}" — ${ws.repos.length} repo(s)` +
            (ws.profile ? `, profile: ${ws.profile}` : ""),
        );
      },
    );

  cmd
    .command("list")
    .description("list workspaces")
    .action(async () => {
      const cfg = await loadConfig();
      if (cfg.workspaces.length === 0) {
        info("no workspaces yet — lzo workspace add <name> --repos <a,b>");
        return;
      }
      for (const w of cfg.workspaces) {
        const current = cfg.currentWorkspace === w.name ? " (current)" : "";
        info(
          `${w.name}${current}${w.profile ? ` [profile: ${w.profile}]` : ""}`,
        );
        for (const r of w.repos) info(`  └ ${r}`);
      }
    });

  cmd
    .command("remove <name>")
    .description("remove a workspace (repos and data are untouched)")
    .action(async (name: string) => {
      await removeWorkspace(name);
      ok(`workspace "${name}" removed`);
    });

  cmd
    .command("use <name>")
    .description("set the current workspace")
    .action(async (name: string) => {
      await setCurrentWorkspace(name);
      ok(`current workspace: ${name}`);
    });

  const repo = new Command("repo").description("manage a workspace's repos");
  repo
    .command("add <workspace> <path>")
    .description("add a repo folder to a workspace")
    .action(async (workspace: string, p: string) => {
      await addRepoToWorkspace(workspace, p);
      ok(`added ${p} → ${workspace}`);
    });
  cmd.addCommand(repo);

  return cmd;
}
