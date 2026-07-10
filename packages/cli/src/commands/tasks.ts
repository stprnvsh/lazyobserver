/**
 * `lzo connect` / `lzo tasks` / `lzo work` — the task hub.
 *
 * Deliberately simple by design (per spec): list what's on your plate,
 * keep every step tracked and synced two-way. No AI day-planning.
 */
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  loadConfig,
  localDate,
  saveConfig,
  setSecret,
  Store,
} from "@lazyobserver/core";
import { Command } from "commander";

import {
  buildAdapters,
  completeTask,
  findTask,
  listTasks,
  startTask,
  syncTasks,
} from "../lib/tasks/sync.js";
import { fail, heading, info, ok, warn } from "../ui.js";

const run = promisify(execFile);

async function currentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "branch", "--show-current"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

const STATUS_ICON: Record<string, string> = {
  in_progress: "▶",
  review: "⏳",
  blocked: "✖",
  todo: "·",
  done: "✓",
};

export function connectCommand(): Command {
  const cmd = new Command("connect").description(
    "connect task sources to the current workspace",
  );

  cmd
    .command("clickup")
    .option("--team <id>", "ClickUp team (workspace) id — omit to auto-discover from the API key")
    .option("--lists <ids>", "comma-separated list ids (else assigned-to-me)")
    .option("--token <token>", "personal API key (omit to be prompted)")
    .description("connect ClickUp with just an API key (kept in the local keychain)")
    .action(
      async (opts: { team?: string; lists?: string; token?: string }) => {
        let token = opts.token;
        if (!token) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          token = (await rl.question("ClickUp personal API key: ")).trim();
          rl.close();
        }
        if (!token) throw new Error("no API key provided");

        // resolve the team: explicit flag, or discover from the key
        let teamId = opts.team;
        if (!teamId) {
          const { discoverClickUpTeams } = await import("../lib/tasks/clickup.js");
          const teams = await discoverClickUpTeams(token);
          if (teams.length === 0) throw new Error("API key sees no ClickUp workspaces");
          if (teams.length === 1) {
            teamId = teams[0].id;
            info(`workspace auto-discovered: ${teams[0].name} (${teamId})`);
          } else {
            info("this key can see several workspaces:");
            for (const t of teams) info(`  ${t.id}  ${t.name}`);
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            teamId = (await rl.question("team id to use: ")).trim();
            rl.close();
            if (!teams.some((t) => t.id === teamId))
              throw new Error(`"${teamId}" is not one of the listed team ids`);
          }
        }

        await setSecret("clickup", token);
        const cfg = await loadConfig();
        const ws = cfg.workspaces.find((w) => w.name === cfg.currentWorkspace);
        if (!ws) throw new Error("no current workspace — lzo workspace use <name>");
        ws.connections.clickup = {
          teamId,
          listIds: opts.lists ? opts.lists.split(",").map((s) => s.trim()) : [],
        };
        await saveConfig(cfg);
        ok(`ClickUp connected to workspace "${ws.name}" (team ${teamId})`);
        info("API key stored in the macOS keychain — sync with: lzo tasks sync");
      },
    );

  cmd
    .command("github")
    .requiredOption("--repos <list>", "comma-separated owner/repo entries")
    .description("connect GitHub Issues via the gh CLI (uses gh's auth)")
    .action(async (opts: { repos: string }) => {
      try {
        await run("gh", ["auth", "status"]);
      } catch {
        warn("gh is not authenticated — run: gh auth login");
      }
      const cfg = await loadConfig();
      const ws = cfg.workspaces.find((w) => w.name === cfg.currentWorkspace);
      if (!ws) throw new Error("no current workspace — lzo workspace use <name>");
      ws.connections.github = {
        repos: opts.repos.split(",").map((s) => s.trim()),
      };
      await saveConfig(cfg);
      ok(`GitHub connected: ${ws.connections.github.repos.join(", ")}`);
    });

  return cmd;
}

export function tasksCommand(): Command {
  const cmd = new Command("tasks").description(
    "unified task list (ClickUp + GitHub)",
  );

  cmd
    .command("sync")
    .description("pull from all connected sources (two-way base state)")
    .action(async () => {
      const store = await Store.open();
      const adapters = await buildAdapters();
      if (!adapters.clickup && !adapters.github) {
        warn("no task sources connected — lzo connect clickup|github");
        return;
      }
      const res = await syncTasks(store, adapters);
      for (const [source, n] of Object.entries(res.bySource))
        ok(`${source}: ${n} task(s) pulled`);
      for (const e of res.errors) fail(e);
      info("daemon commits them within ~2s — lzo tasks");
    });

  cmd
    .command("list", { isDefault: true })
    .option("--all", "include done")
    .option("--today", "due today/overdue or in progress")
    .description("show the unified task list")
    .action(async (opts: { all?: boolean; today?: boolean }) => {
      const store = await Store.open();
      let tasks = await listTasks(store);
      if (!opts.all) tasks = tasks.filter((t) => t.status !== "done");
      if (opts.today) {
        const today = localDate();
        tasks = tasks.filter(
          (t) =>
            t.status === "in_progress" ||
            (t.due !== "" && t.due <= today),
        );
      }
      if (tasks.length === 0) {
        info("no tasks — lzo tasks sync");
        return;
      }
      heading(`tasks (${tasks.length})`);
      for (const t of tasks) {
        const extras = [
          t.sprint && `sprint: ${t.sprint}`,
          t.due && `due: ${t.due}`,
          t.branch && `branch: ${t.branch}`,
          t.pr_url && `PR: ${t.pr_url}`,
        ]
          .filter(Boolean)
          .join(" · ");
        info(
          `${STATUS_ICON[t.status] ?? "·"} [${t.status}] ${t.source_id}  ${t.title}${extras ? `  (${extras})` : ""}`,
        );
      }
    });

  cmd
    .command("show <ref>")
    .description("full detail for one task")
    .action(async (ref: string) => {
      const store = await Store.open();
      const t = await findTask(store, ref);
      heading(t.title);
      info(`id: ${t.id} — status: ${t.status} (${t.raw_status})`);
      if (t.sprint) info(`sprint: ${t.sprint}`);
      if (t.due) info(`due: ${t.due}`);
      if (t.repo) info(`repo: ${t.repo}${t.branch ? ` @ ${t.branch}` : ""}`);
      if (t.pr_url) info(`PR: ${t.pr_url}`);
      info(`url: ${t.url}`);
      if (t.body) console.log(`\n${t.body.slice(0, 1500)}`);
    });

  cmd
    .command("start <ref>")
    .description("mark in-progress (source + local), link cwd repo/branch")
    .action(async (ref: string) => {
      const store = await Store.open();
      const t = await findTask(store, ref);
      const adapters = await buildAdapters();
      const cwd = process.cwd();
      await startTask(t, adapters, {
        repo: cwd,
        branch: await currentBranch(cwd),
      });
      ok(`started: ${t.title} (synced to ${t.source})`);
    });

  cmd
    .command("done <ref>")
    .description("complete: source status + comment with branch/PR, local row")
    .action(async (ref: string) => {
      const store = await Store.open();
      const t = await findTask(store, ref);
      const adapters = await buildAdapters();
      await completeTask(t, adapters);
      ok(`done: ${t.title} (status + completion comment pushed to ${t.source})`);
    });

  cmd
    .command("link <ref>")
    .description("attach the cwd repo + current branch to a task")
    .action(async (ref: string) => {
      const store = await Store.open();
      const t = await findTask(store, ref);
      const cwd = process.cwd();
      const branch = await currentBranch(cwd);
      const { updateLocalTask } = await import("../lib/tasks/sync.js");
      await updateLocalTask(t, { repo: cwd, branch });
      ok(`linked ${t.source_id} -> ${cwd}${branch ? ` @ ${branch}` : ""}`);
    });

  return cmd;
}

export function workCommand(): Command {
  return new Command("work")
    .argument("<ref>", "task id / source id / title fragment")
    .description(
      "launch claude on a task: pinned profile, task context injected, events tagged",
    )
    .action(async (ref: string) => {
      const store = await Store.open();
      const t = await findTask(store, ref);
      const cfg = await loadConfig();
      const cwd = t.repo || process.cwd();
      const ws =
        cfg.workspaces.find((w) => w.repos.includes(cwd)) ??
        cfg.workspaces.find((w) => w.name === cfg.currentWorkspace);
      const profile = cfg.profiles.find((p) => p.name === ws?.profile);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LAZYOBSERVER_TASK_ID: t.id,
      };
      if (profile) env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir;

      const context =
        `Working on task ${t.source_id}: ${t.title}\n` +
        (t.body ? `\n${t.body.slice(0, 1200)}\n` : "") +
        (t.url ? `\nSource: ${t.url}` : "") +
        `\n(When done, the task can be completed with \`lzo tasks done ${t.source_id}\`.)`;

      ok(`launching claude in ${cwd} (task ${t.source_id}${profile ? `, profile ${profile.name}` : ""})`);
      const child = spawn("claude", [context], {
        cwd,
        env,
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
