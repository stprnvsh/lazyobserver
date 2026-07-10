/**
 * Task sync engine.
 *
 * pull:  adapters -> unified tasks -> spool upserts (daemon = single writer);
 *        local fields (repo/branch/pr_url) are preserved across syncs.
 * push:  start/done -> the source system (status + completion comment with
 *        branch/PR), then the local row via the spool.
 */
import { loadConfig, Store, TABLES } from "@lazyobserver/core";
import { queueMemWrite } from "@lazyobserver/daemon/memwrite";

import { ClickUpAdapter } from "./clickup.js";
import { GitHubAdapter } from "./github.js";
import {
  parseTaskDescription,
  taskRow,
  type UnifiedTask,
} from "./model.js";

export interface Adapters {
  clickup?: ClickUpAdapter;
  github?: GitHubAdapter;
}

export async function buildAdapters(): Promise<Adapters> {
  const cfg = await loadConfig();
  const ws = cfg.workspaces.find((w) => w.name === cfg.currentWorkspace);
  const out: Adapters = {};
  const cu = ws?.connections.clickup;
  if (cu)
    out.clickup = new ClickUpAdapter(cu.teamId, {
      listIds: cu.listIds,
      sprintFolderIds: cu.sprintFolderIds,
    });
  const gh = ws?.connections.github;
  if (gh && gh.repos.length > 0) out.github = new GitHubAdapter(gh.repos);
  return out;
}

export interface SyncResult {
  pulled: number;
  bySource: Record<string, number>;
  errors: string[];
}

export async function syncTasks(
  store: Store,
  adapters: Adapters,
): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, bySource: {}, errors: [] };
  const tbl = await store.table(TABLES.tasks);
  const existing = (await tbl.query().limit(5000).toArray()) as Record<
    string,
    unknown
  >[];
  const localById = new Map(existing.map((r) => [String(r.id), r]));

  const pulls: [string, UnifiedTask[]][] = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    try {
      pulls.push([name, await adapter.pull()]);
    } catch (err) {
      result.errors.push(`${name}: ${(err as Error).message}`);
    }
  }

  for (const [name, tasks] of pulls) {
    result.bySource[name] = tasks.length;
    for (const t of tasks) {
      const local = localById.get(t.id);
      await queueMemWrite({
        table: TABLES.tasks,
        row: taskRow(t, {
          repo: local ? String(local.repo ?? "") : "",
          branch: local ? String(local.branch ?? "") : "",
          pr_url: local ? String(local.pr_url ?? "") : "",
        }),
      });
      result.pulled++;
    }
  }
  return result;
}

export interface StoredTask {
  id: string;
  source: string;
  source_id: string;
  title: string;
  status: string;
  raw_status: string;
  due: string;
  body: string;
  sprint: string;
  url: string;
  repo: string;
  branch: string;
  pr_url: string;
  assignee: string;
  updated_at: number;
}

export function rowToStoredTask(r: Record<string, unknown>): StoredTask {
  const desc = parseTaskDescription(String(r.description ?? ""));
  return {
    id: String(r.id),
    source: String(r.source),
    source_id: String(r.source_id),
    title: String(r.title ?? ""),
    status: String(r.status ?? "todo"),
    raw_status: desc.raw_status,
    due: desc.due,
    body: desc.body,
    sprint: String(r.sprint ?? ""),
    url: String(r.url ?? ""),
    repo: String(r.repo ?? ""),
    branch: String(r.branch ?? ""),
    pr_url: String(r.pr_url ?? ""),
    assignee: String(r.assignee ?? ""),
    updated_at: Number(r.updated_at ?? 0),
  };
}

/** Case-insensitive assignee match against any needle (name/email/login). */
export function taskMatchesAssignee(
  task: Pick<StoredTask, "assignee">,
  needles: string[],
): boolean {
  const hay = task.assignee.toLowerCase();
  return needles.some((n) => n && hay.includes(n.toLowerCase()));
}

/**
 * My identifiers across connected sources — ClickUp username/email + GitHub
 * login. Resolved once via the APIs and cached into the workspace config so
 * `--mine` stays instant afterwards.
 */
export async function resolveMyIdentifiers(
  adapters: Adapters,
): Promise<string[]> {
  const { loadConfig: load, saveConfig } = await import("@lazyobserver/core");
  const cfg = await load();
  const ws = cfg.workspaces.find((w) => w.name === cfg.currentWorkspace);
  const needles: string[] = [];
  let changed = false;

  if (ws?.connections.clickup) {
    if (!ws.connections.clickup.me && adapters.clickup) {
      try {
        ws.connections.clickup.me = await adapters.clickup.getMe();
        changed = true;
      } catch {
        /* offline — filter on what we have */
      }
    }
    const me = ws.connections.clickup.me;
    if (me) needles.push(me.username, me.email);
  }
  if (ws?.connections.github) {
    if (!ws.connections.github.me) {
      try {
        const { defaultGhRunner } = await import("./github.js");
        const out = await defaultGhRunner(["api", "user", "--jq", ".login"]);
        const login = out.trim();
        if (login) {
          ws.connections.github.me = { login };
          changed = true;
        }
      } catch {
        /* gh unavailable */
      }
    }
    if (ws.connections.github.me) needles.push(ws.connections.github.me.login);
  }

  if (changed) await saveConfig(cfg);
  return needles.filter(Boolean);
}

export async function listTasks(store: Store): Promise<StoredTask[]> {
  const tbl = await store.table(TABLES.tasks);
  const rows = (await tbl.query().limit(5000).toArray()) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToStoredTask).sort((a, b) => {
    const order: Record<string, number> = {
      in_progress: 0,
      review: 1,
      blocked: 2,
      todo: 3,
      done: 4,
    };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });
}

/** Find one task by (a prefix of) its id / source_id — CLI ergonomics. */
export async function findTask(
  store: Store,
  ref: string,
): Promise<StoredTask> {
  const tasks = await listTasks(store);
  const hit =
    tasks.find((t) => t.id === ref || t.source_id === ref) ??
    tasks.filter(
      (t) => t.id.includes(ref) || t.source_id.includes(ref) || t.title.toLowerCase().includes(ref.toLowerCase()),
    );
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0];
    if (hit.length === 0) throw new Error(`no task matches "${ref}"`);
    throw new Error(
      `"${ref}" is ambiguous: ${hit.slice(0, 5).map((t) => t.id).join(", ")}`,
    );
  }
  return hit;
}

/** Update the local row (through the spool), preserving unknown fields. */
export async function updateLocalTask(
  task: StoredTask,
  patch: Partial<Pick<StoredTask, "status" | "repo" | "branch" | "pr_url">>,
): Promise<void> {
  await queueMemWrite({
    table: TABLES.tasks,
    row: {
      id: task.id,
      source: task.source,
      source_id: task.source_id,
      title: task.title,
      description: JSON.stringify({
        raw_status: task.raw_status,
        due: task.due,
        body: task.body,
      }),
      status: patch.status ?? task.status,
      sprint: task.sprint,
      url: task.url,
      repo: patch.repo ?? task.repo,
      branch: patch.branch ?? task.branch,
      pr_url: patch.pr_url ?? task.pr_url,
      assignee: task.assignee,
      updated_at: Date.now(),
      synced_at: Date.now(),
    },
  });
}

export async function startTask(
  task: StoredTask,
  adapters: Adapters,
  local: { repo?: string; branch?: string },
): Promise<void> {
  if (task.source === "clickup" && adapters.clickup) {
    await adapters.clickup.start(task.source_id);
  } else if (task.source === "github" && adapters.github) {
    await adapters.github.start(task.source_id);
  }
  await updateLocalTask(task, { status: "in_progress", ...local });
}

export async function completeTask(
  task: StoredTask,
  adapters: Adapters,
): Promise<void> {
  const note = [
    "Completed via lazyobserver.",
    task.branch ? `branch: ${task.branch}` : "",
    task.pr_url ? `PR: ${task.pr_url}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
  if (task.source === "clickup" && adapters.clickup) {
    await adapters.clickup.complete(task.source_id, note);
  } else if (task.source === "github" && adapters.github) {
    await adapters.github.complete(task.source_id, note);
  }
  await updateLocalTask(task, { status: "done" });
}
