import { useEffect, useMemo, useState } from "react";

import { api, pj, type StoredTask } from "../api";
import { Avatar, Empty, Loading, Section, Tag } from "../components";

const GROUPS: [string, string][] = [
  ["in_progress", "In progress"],
  ["review", "In review"],
  ["blocked", "Blocked"],
  ["todo", "To do"],
  ["done", "Done"],
];

export function Tasks() {
  const [tasks, setTasks] = useState<StoredTask[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.tasks().then(setTasks).catch(() => setTasks([]));
  }, []);

  const filtered = useMemo(() => {
    if (!tasks) return [];
    const needle = q.toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (t) =>
        (t.assignee || "").toLowerCase().includes(needle) ||
        (t.title || "").toLowerCase().includes(needle) ||
        (t.sprint || "").toLowerCase().includes(needle),
    );
  }, [tasks, q]);

  if (!tasks) return <Loading />;

  return (
    <>
      <input
        className="search"
        placeholder="Filter by assignee, title or sprint — try your name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {GROUPS.map(([status, label]) => {
        const group = filtered.filter((t) => t.status === status);
        if (group.length === 0) return null;
        return (
          <Section title={label} count={group.length} key={status}>
            {group.map((t) => {
              const d = pj(t.description);
              return (
                <div className="row" key={t.id}>
                  <Tag status={t.status} mono>
                    {t.source}
                  </Tag>
                  <span className="grow">
                    <a href={t.url} target="_blank" rel="noreferrer">
                      {t.source_id}
                    </a>{" "}
                    {t.title}
                  </span>
                  <Avatar name={t.assignee} />
                  <span className="faint meta">
                    {t.sprint}
                    {d.due ? ` · due ${d.due}` : ""}
                    {t.branch ? ` · ${t.branch}` : ""}
                  </span>
                </div>
              );
            })}
          </Section>
        );
      })}
      {filtered.length === 0 && (
        <Section title="Tasks" count={0}>
          <Empty msg="no matching tasks" cmd="lzo tasks sync" />
        </Section>
      )}
    </>
  );
}
