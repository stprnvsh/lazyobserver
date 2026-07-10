/** Typed client for the lazyobserver local API (same origin). */

export interface Totals {
  sessions: number;
  minutes: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  userPrompts: number;
  agentActions: number;
}

export interface StoredTask {
  id: string;
  source: string;
  source_id: string;
  title: string;
  status: string;
  sprint: string;
  url: string;
  repo: string;
  branch: string;
  pr_url: string;
  assignee: string;
  description?: string;
  due?: string;
}

export interface SessionRow {
  id: string;
  repo: string;
  branch: string;
  surface: string;
  model: string;
  minutes: number;
  tokens_in: number;
  tokens_out: number;
}

export interface Decision {
  context: string;
  choice: string;
  rationale: string;
  proposed_by: string;
  decided_by: string;
}

export interface DayReport {
  date: string;
  material: { sessions: SessionRow[]; eventStats: Record<string, number> };
  tasks: {
    doneToday: StoredTask[];
    workedOn: StoredTask[];
    sprints: { name: string; done: number; total: number; percent: number }[];
    percentDone: number;
    minutesByTask: Record<string, number>;
    open: StoredTask[];
  };
  totals: Totals;
  decisions: Decision[];
  dayDoc: { title: string; body: string } | null;
}

export interface EventRow {
  id: string;
  ts: number;
  actor: string;
  kind: string;
  payload: string;
  task_id: string;
  session_id: string;
}

export interface JournalRow {
  id: string;
  date: string;
  kind: string;
  title: string;
  body: string;
  created_at: number;
}

export interface MemoryHit {
  kind: string;
  title: string;
  body: string;
  repo: string;
}

export interface MessageHit {
  role: string;
  content: string;
  ts: number;
  repo: string;
  session_id: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  report: (date: string) => get<DayReport>(`/api/report?date=${date}`),
  events: (date: string) => get<EventRow[]>(`/api/events?date=${date}`),
  tasks: () => get<StoredTask[]>(`/api/tasks`),
  journal: (date: string) => get<JournalRow[]>(`/api/journal?date=${date}`),
  search: (q: string) =>
    get<{ memory: MemoryHit[]; messages: MessageHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
};

/** one bad payload must never kill a view */
export function pj(s: string | undefined | null): Record<string, any> {
  try {
    return JSON.parse(s || "{}") || {};
  } catch {
    return {};
  }
}
