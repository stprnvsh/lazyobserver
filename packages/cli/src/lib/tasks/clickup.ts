/**
 * ClickUp adapter (API v2, personal token from the local keychain).
 *
 * Pull = the UNION of three sources, deduped by task id:
 *   1. tasks assigned to the authed user (team-wide)
 *   2. configured lists, in full (all assignees)
 *   3. the CURRENT sprint list of each configured sprint folder — sprints
 *      rotate, so the folder is stored and the live list resolved by its
 *      date range at sync time
 *
 * All task fetches paginate (ClickUp caps at 100/page — a plain fetch
 * silently truncates bigger backlogs).
 *
 * Push: status transition + completion comment; "done" uses the list's own
 * done-type status name (statuses are per-list customs).
 */
import { getSecret } from "@lazyobserver/core";

import { mapClickUpStatus, type UnifiedTask } from "./model.js";

const BASE = "https://api.clickup.com/api/v2";
const PAGE_SIZE = 100;
const MAX_PAGES = 30; // 3000 tasks per source — a guardrail, not a quota

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Discover the teams (workspaces) a token can see — lets `lzo connect
 * clickup` work with JUST an API key, no team id needed up front.
 */
export async function discoverClickUpTeams(
  token: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<{ id: string; name: string }[]> {
  const res = await fetchFn(`${BASE}/team`, {
    headers: { Authorization: token },
  });
  if (!res.ok) {
    throw new Error(
      `ClickUp /team -> ${res.status}${res.status === 401 ? " (invalid API key?)" : ""}`,
    );
  }
  const data = (await res.json()) as { teams?: { id: string | number; name: string }[] };
  return (data.teams ?? []).map((t) => ({ id: String(t.id), name: t.name }));
}

export interface CuListMeta {
  id: string;
  name: string;
  task_count?: number | null;
  start_date?: string | null;
  due_date?: string | null;
}

export interface CuHierarchy {
  spaces: {
    id: string;
    name: string;
    folders: { id: string; name: string; lists: CuListMeta[] }[];
    lists: CuListMeta[]; // folderless
  }[];
}

/** Spaces -> folders (with lists) + folderless lists — for `--browse`. */
export async function discoverClickUpHierarchy(
  token: string,
  teamId: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<CuHierarchy> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${BASE}${path}`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  };
  const { spaces } = await get<{ spaces: { id: string; name: string }[] }>(
    `/team/${teamId}/space?archived=false`,
  );
  const out: CuHierarchy = { spaces: [] };
  for (const s of spaces) {
    const { folders } = await get<{
      folders: { id: string; name: string; lists?: CuListMeta[] }[];
    }>(`/space/${s.id}/folder?archived=false`);
    const { lists } = await get<{ lists: CuListMeta[] }>(
      `/space/${s.id}/list?archived=false`,
    );
    out.spaces.push({
      id: s.id,
      name: s.name,
      folders: folders.map((f) => ({ id: f.id, name: f.name, lists: f.lists ?? [] })),
      lists,
    });
  }
  return out;
}

/**
 * Which list in a sprint folder is the CURRENT sprint?
 *  - a list whose [start_date, due_date] covers `now`
 *  - else the most recently STARTED list (the sprint that just ran)
 *  - else the last list in the folder
 */
export function pickCurrentSprintList(
  lists: CuListMeta[],
  now: number = Date.now(),
): CuListMeta | null {
  if (lists.length === 0) return null;
  const dated = lists.filter((l) => l.start_date && l.due_date);
  const covering = dated.find(
    (l) => Number(l.start_date) <= now && now <= Number(l.due_date),
  );
  if (covering) return covering;
  const started = dated
    .filter((l) => Number(l.start_date) <= now)
    .sort((a, b) => Number(b.start_date) - Number(a.start_date));
  if (started.length > 0) return started[0];
  return lists[lists.length - 1];
}

interface CuStatus {
  status: string;
  type?: string;
}

interface CuTask {
  id: string;
  name: string;
  text_content?: string;
  status: CuStatus;
  url: string;
  due_date?: string | null;
  date_updated?: string;
  assignees?: { username?: string; email?: string }[];
  list?: { id: string; name?: string };
  folder?: { name?: string };
}

export interface ClickUpOptions {
  listIds?: string[];
  sprintFolderIds?: string[];
  fetchFn?: FetchFn;
  tokenFn?: () => Promise<string | null>;
  now?: () => number;
}

export class ClickUpAdapter {
  private readonly listIds: string[];
  private readonly sprintFolderIds: string[];
  private readonly fetchFn: FetchFn;
  private readonly tokenFn: () => Promise<string | null>;
  private readonly now: () => number;

  constructor(
    private readonly teamId: string,
    opts: ClickUpOptions = {},
  ) {
    this.listIds = opts.listIds ?? [];
    this.sprintFolderIds = opts.sprintFolderIds ?? [];
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
    this.tokenFn = opts.tokenFn ?? (() => getSecret("clickup"));
    this.now = opts.now ?? Date.now;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.tokenFn();
    if (!token)
      throw new Error("ClickUp token missing — run: lzo connect clickup");
    return { Authorization: token, "Content-Type": "application/json" };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      headers: await this.headers(),
    });
    if (!res.ok) throw new Error(`ClickUp GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** Fetch every page of a task query (ClickUp caps at 100/page). */
  private async pagedTasks(basePath: string): Promise<CuTask[]> {
    const all: CuTask[] = [];
    const sep = basePath.includes("?") ? "&" : "?";
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.get<{ tasks?: CuTask[]; last_page?: boolean }>(
        `${basePath}${sep}page=${page}`,
      );
      const tasks = data.tasks ?? [];
      all.push(...tasks);
      if (data.last_page === true || tasks.length < PAGE_SIZE) break;
    }
    return all;
  }

  private toUnified(t: CuTask, sprintName?: string): UnifiedTask {
    const due = t.due_date ? new Date(Number(t.due_date)).toLocaleDateString("en-CA") : "";
    return {
      id: `clickup:${t.id}`,
      source: "clickup",
      source_id: t.id,
      title: t.name,
      description: t.text_content ?? "",
      status: mapClickUpStatus(t.status),
      raw_status: t.status?.status ?? "",
      sprint: sprintName ?? t.list?.name ?? t.folder?.name ?? "",
      url: t.url,
      assignee: t.assignees?.[0]?.username ?? t.assignees?.[0]?.email ?? "",
      due,
      updated_at: t.date_updated ? Number(t.date_updated) : Date.now(),
    };
  }

  /** Union pull: assigned-to-me + configured lists + current sprint list(s). */
  async pull(): Promise<UnifiedTask[]> {
    const out = new Map<string, UnifiedTask>();
    const put = (t: UnifiedTask, fromSprint = false): void => {
      // ClickUp keeps a task's PRIMARY list as its `list` field even when the
      // task is (also) in a sprint — so a task seen first via assigned-to-me
      // arrives tagged with its home list ("Product Backlog"). The sprint
      // pull is the authoritative sprint tag: it always overwrites.
      const prev = out.get(t.id);
      if (!prev) {
        out.set(t.id, t);
      } else if (fromSprint) {
        out.set(t.id, { ...prev, sprint: t.sprint });
      } else if (t.sprint && !prev.sprint) {
        out.set(t.id, t);
      }
    };

    // 1. assigned to me, team-wide
    const me = await this.get<{ user: { id: number } }>("/user");
    for (const t of await this.pagedTasks(
      `/team/${this.teamId}/task?assignees[]=${me.user.id}&include_closed=false&subtasks=true`,
    )) {
      put(this.toUnified(t));
    }

    // NOTE: plain /list/{id}/task MISSES "tasks in multiple lists" (a task
    // added to a sprint keeps its home list). The team endpoint with
    // list_ids[] + include_timl=true returns true list membership —
    // verified live: 3 tasks without the flag, 98 (= UI count) with it.
    const listPull = (listId: string, includeClosed: boolean): Promise<CuTask[]> =>
      this.pagedTasks(
        `/team/${this.teamId}/task?list_ids[]=${listId}&include_closed=${includeClosed}&subtasks=true&include_timl=true`,
      );

    // 2. explicit lists, in full (open only — backlogs carry years of done)
    for (const listId of this.listIds) {
      for (const t of await listPull(listId, false)) put(this.toUnified(t));
    }

    // 3. sprint folders -> current sprint list, INCLUDING closed tasks —
    //    sprint progress (done/total) needs the completed ones
    for (const folderId of this.sprintFolderIds) {
      const { lists } = await this.get<{ lists: CuListMeta[] }>(
        `/folder/${folderId}/list?archived=false`,
      );
      const current = pickCurrentSprintList(lists, this.now());
      if (!current) continue;
      for (const t of await listPull(current.id, true)) {
        put(this.toUnified(t, current.name), true);
      }
    }

    return [...out.values()];
  }

  /** The list's done-type status name (statuses are per-list customs). */
  private async doneStatusForTask(taskId: string): Promise<string> {
    const task = await this.get<{ list?: { id: string } }>(`/task/${taskId}`);
    if (task.list?.id) {
      const list = await this.get<{ statuses?: CuStatus[] }>(
        `/list/${task.list.id}`,
      );
      const done = (list.statuses ?? []).find(
        (s) => (s.type ?? "").toLowerCase() === "done" || (s.type ?? "").toLowerCase() === "closed",
      );
      if (done) return done.status;
    }
    return "complete";
  }

  async setStatus(sourceId: string, rawStatus: string): Promise<void> {
    const res = await this.fetchFn(`${BASE}/task/${sourceId}`, {
      method: "PUT",
      headers: await this.headers(),
      body: JSON.stringify({ status: rawStatus }),
    });
    if (!res.ok) throw new Error(`ClickUp status update -> ${res.status}`);
  }

  async comment(sourceId: string, text: string): Promise<void> {
    const res = await this.fetchFn(`${BASE}/task/${sourceId}/comment`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ comment_text: text }),
    });
    if (!res.ok) throw new Error(`ClickUp comment -> ${res.status}`);
  }

  async start(sourceId: string): Promise<void> {
    // "in progress" is the most common custom name; fall back is harmless —
    // ClickUp rejects unknown statuses and we surface the error.
    await this.setStatus(sourceId, "in progress");
  }

  async complete(sourceId: string, note: string): Promise<void> {
    const done = await this.doneStatusForTask(sourceId);
    await this.setStatus(sourceId, done);
    if (note) await this.comment(sourceId, note);
  }
}
