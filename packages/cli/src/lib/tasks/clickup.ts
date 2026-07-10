/**
 * ClickUp adapter (API v2, personal token from the local keychain).
 *
 * Pull: tasks assigned to the authed user (team-wide, open) or from the
 * configured lists. Push: status transition + a completion comment carrying
 * branch/PR. The list's own status vocabulary is respected — "done" pushes
 * the list's actual done-type status name.
 */
import { getSecret } from "@lazyobserver/core";

import { mapClickUpStatus, type UnifiedTask } from "./model.js";

const BASE = "https://api.clickup.com/api/v2";

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

export class ClickUpAdapter {
  constructor(
    private readonly teamId: string,
    private readonly listIds: string[] = [],
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    private readonly tokenFn: () => Promise<string | null> = () =>
      getSecret("clickup"),
  ) {}

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

  private toUnified(t: CuTask): UnifiedTask {
    const due = t.due_date ? new Date(Number(t.due_date)).toLocaleDateString("en-CA") : "";
    return {
      id: `clickup:${t.id}`,
      source: "clickup",
      source_id: t.id,
      title: t.name,
      description: t.text_content ?? "",
      status: mapClickUpStatus(t.status),
      raw_status: t.status?.status ?? "",
      sprint: t.list?.name ?? t.folder?.name ?? "",
      url: t.url,
      assignee: t.assignees?.[0]?.username ?? t.assignees?.[0]?.email ?? "",
      due,
      updated_at: t.date_updated ? Number(t.date_updated) : Date.now(),
    };
  }

  /** Pull open tasks: from configured lists, else assigned-to-me team-wide. */
  async pull(): Promise<UnifiedTask[]> {
    if (this.listIds.length > 0) {
      const all: UnifiedTask[] = [];
      for (const listId of this.listIds) {
        const data = await this.get<{ tasks: CuTask[] }>(
          `/list/${listId}/task?include_closed=false`,
        );
        all.push(...data.tasks.map((t) => this.toUnified(t)));
      }
      return all;
    }
    const me = await this.get<{ user: { id: number } }>("/user");
    const data = await this.get<{ tasks: CuTask[] }>(
      `/team/${this.teamId}/task?assignees[]=${me.user.id}&include_closed=false&subtasks=true`,
    );
    return data.tasks.map((t) => this.toUnified(t));
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
