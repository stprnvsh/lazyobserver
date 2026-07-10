/**
 * The unified task model — ClickUp tasks and GitHub issues normalize into
 * one shape with one status vocabulary, stored in the `tasks` table
 * (id = `${source}:${source_id}`, embedded for semantic search).
 */

export type UnifiedStatus =
  | "todo"
  | "in_progress"
  | "review"
  | "done"
  | "blocked";

export interface UnifiedTask {
  id: string;
  source: "clickup" | "github";
  source_id: string;
  title: string;
  description: string;
  status: UnifiedStatus;
  /** raw source status name — needed to push the right transition back */
  raw_status: string;
  sprint: string;
  url: string;
  assignee: string;
  due: string; // YYYY-MM-DD or ""
  updated_at: number;
}

export function taskRow(
  t: UnifiedTask,
  extra: { repo?: string; branch?: string; pr_url?: string } = {},
): Record<string, unknown> {
  return {
    id: t.id,
    source: t.source,
    source_id: t.source_id,
    title: t.title,
    // raw status + due ride along in the description head so pushes and
    // "today" filters don't need extra columns
    description: JSON.stringify({
      raw_status: t.raw_status,
      due: t.due,
      body: t.description.slice(0, 4000),
    }),
    status: t.status,
    sprint: t.sprint,
    url: t.url,
    repo: extra.repo ?? "",
    branch: extra.branch ?? "",
    pr_url: extra.pr_url ?? "",
    assignee: t.assignee,
    updated_at: t.updated_at,
    synced_at: Date.now(),
  };
}

export function parseTaskDescription(desc: string): {
  raw_status: string;
  due: string;
  body: string;
} {
  try {
    const d = JSON.parse(desc) as { raw_status?: string; due?: string; body?: string };
    return { raw_status: d.raw_status ?? "", due: d.due ?? "", body: d.body ?? "" };
  } catch {
    return { raw_status: "", due: "", body: desc };
  }
}

/**
 * ClickUp status -> unified. ClickUp statuses are per-list customs but carry
 * a `type` (open | custom | done | closed); names fill in the nuance.
 */
export function mapClickUpStatus(status: {
  status: string;
  type?: string;
}): UnifiedStatus {
  const name = (status.status ?? "").toLowerCase();
  const type = (status.type ?? "").toLowerCase();
  if (type === "done" || type === "closed") return "done";
  if (/block/.test(name)) return "blocked";
  if (/review|qa|test/.test(name)) return "review";
  if (/progress|doing|active|develop/.test(name)) return "in_progress";
  if (type === "open" || /to.?do|open|backlog|new/.test(name)) return "todo";
  return "in_progress"; // custom mid-flow status
}

/** GitHub issue -> unified (state + labels). */
export function mapGitHubStatus(issue: {
  state: string;
  labels?: { name: string }[];
}): UnifiedStatus {
  if (issue.state.toLowerCase() === "closed") return "done";
  const labels = (issue.labels ?? []).map((l) => l.name.toLowerCase());
  if (labels.some((l) => /block/.test(l))) return "blocked";
  if (labels.some((l) => /review/.test(l))) return "review";
  if (labels.some((l) => /progress|doing|wip/.test(l))) return "in_progress";
  return "todo";
}
