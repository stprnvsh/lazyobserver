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
  pinProfile,
  removeRepoFromWorkspace,
  removeWorkspace,
  setCurrentWorkspace,
} from "@lazyobserver/core";

import { heading, info, ok } from "../ui.js";

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

  cmd
    .command("show <name>")
    .description("full workspace detail: repos, profile, task connections")
    .action(async (name: string) => {
      const cfg = await loadConfig();
      const w = cfg.workspaces.find((x) => x.name === name);
      if (!w) throw new Error(`Workspace "${name}" not found.`);
      heading(w.name + (cfg.currentWorkspace === w.name ? " (current)" : ""));
      info(`profile: ${w.profile ?? "(none — sessions use the default account)"}`);
      heading("repos");
      if (w.repos.length === 0) info("(none)");
      for (const r of w.repos) info(r);
      heading("connections");
      const cu = w.connections.clickup;
      if (cu) {
        info(
          `clickup: team ${cu.teamId}` +
            (cu.me ? ` — me: ${cu.me.username}` : "") +
            (cu.sprintFolderIds.length
              ? ` — sprint folder(s): ${cu.sprintFolderIds.join(", ")}`
              : "") +
            (cu.listIds.length ? ` — lists: ${cu.listIds.join(", ")}` : ""),
        );
      }
      const gh = w.connections.github;
      if (gh)
        info(
          `github: ${gh.repos.join(", ")}${gh.me ? ` — me: ${gh.me.login}` : ""}`,
        );
      if (!cu && !gh) info("(none — lzo connect clickup|github)");
    });

  cmd
    .command("pin <workspace> <profile>")
    .description("pin a profile (sessions in this workspace use that account)")
    .action(async (workspace: string, profile: string) => {
      await pinProfile(workspace, profile);
      ok(`workspace "${workspace}" now pinned to profile "${profile}"`);
    });

  cmd
    .command("unpin <workspace>")
    .description("remove the profile pin")
    .action(async (workspace: string) => {
      await pinProfile(workspace, null);
      ok(`workspace "${workspace}" unpinned`);
    });

  const repo = new Command("repo").description("manage a workspace's repos");
  repo
    .command("add <workspace> <path>")
    .description("add a repo folder to a workspace")
    .action(async (workspace: string, p: string) => {
      await addRepoToWorkspace(workspace, p);
      ok(`added ${p} → ${workspace}`);
    });
  repo
    .command("remove <workspace> <path>")
    .description("remove a repo folder from a workspace (data is untouched)")
    .action(async (workspace: string, p: string) => {
      await removeRepoFromWorkspace(workspace, p);
      ok(`removed ${p} from ${workspace}`);
    });
  cmd.addCommand(repo);

  return cmd;
}
