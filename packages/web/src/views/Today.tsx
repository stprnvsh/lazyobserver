import { useEffect, useState } from "react";

import { api, pj, type DayReport, type EventRow } from "../api";
import { Avatar, Card, Empty, Loading, Section, Tag } from "../components";

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventDetail(e: EventRow): { short: string; full: string } {
  const p = pj(e.payload);
  const input = p.tool_input ?? {};
  const short =
    input.file_path || input.command || p.prompt || p.tool_name || "";
  const full =
    p.prompt ||
    input.command ||
    input.file_path ||
    JSON.stringify(p, null, 2);
  return { short: String(short), full: String(full) };
}

/** One timeline row — CLICK to expand the full prompt/command/payload. */
function TimelineRow({ e }: { e: EventRow }) {
  const [open, setOpen] = useState(false);
  const { short, full } = eventDetail(e);
  const expandable = full.length > 0;
  return (
    <>
      <div
        className="row"
        style={{ cursor: expandable ? "pointer" : "default" }}
        onClick={() => expandable && setOpen(!open)}
        title={expandable ? "click to expand" : undefined}
      >
        <span className="time">{time(e.ts)}</span>
        <Tag color={e.actor === "user" ? "acc" : e.actor === "agent" ? "blue" : ""}>
          {e.actor}
        </Tag>
        <Tag>{e.kind.replace("_", " ")}</Tag>
        <span className="grow faint detail">{short.slice(0, 110)}</span>
        {pj(e.payload).queued && <Tag color="amber">mid-turn</Tag>}
        {e.task_id && (
          <Tag color="amber" mono>
            {e.task_id.split(":").pop()}
          </Tag>
        )}
      </div>
      {open && (
        <div className="row" style={{ background: "rgba(255,255,255,.015)" }}>
          <span className="time" />
          <pre style={{ padding: "6px 0", maxWidth: "100%" }}>{full}</pre>
        </div>
      )}
    </>
  );
}

export function Today({ date }: { date: string }) {
  const [report, setReport] = useState<DayReport | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setReport(null);
    setError("");
    Promise.all([api.report(date), api.events(date)])
      .then(([r, ev]) => {
        setReport(r);
        setEvents(ev);
      })
      .catch((e) => setError(String(e)));
  }, [date]);

  if (error)
    return (
      <Section title="error" count="!">
        <pre>{error}</pre>
      </Section>
    );
  if (!report) return <Loading />;

  const T = report.totals;
  const tasks = report.tasks;
  const touched = tasks.doneToday.length + tasks.workedOn.length;

  return (
    <>
      <div className="cards">
        <Card value={T.sessions} label="sessions" sub={`${T.minutes} min tracked`} />
        <Card
          value={tasks.doneToday.length}
          label="tasks done today"
          sub={`${tasks.workedOn.length} worked on`}
        />
        <Card
          value={(T.tokensIn + T.tokensOut).toLocaleString()}
          label="tokens"
          sub={`$${T.costUsd.toFixed(2)} spent`}
        />
        <Card
          value={
            <>
              {T.userPrompts}{" "}
              <span style={{ color: "var(--faint)", fontSize: 15 }}>→</span>{" "}
              {T.agentActions}
            </>
          }
          label="user → agent"
          sub="prompts → actions"
        />
      </div>

      <Section title="Sessions" count={report.material.sessions.length}>
        {report.material.sessions.length === 0 && (
          <Empty msg="no sessions captured for this day" />
        )}
        {report.material.sessions.map((s) => (
          <div className="row" key={s.id}>
            <Tag color={s.surface === "vscode" ? "blue" : "acc"}>
              {s.surface || "?"}
            </Tag>
            <span className="grow">
              <b>{s.repo.split("/").pop() || "—"}</b>{" "}
              <span className="dim">@ {s.branch || "—"}</span>
            </span>
            <span className="dim nums">
              {s.minutes}m · {(s.tokens_in + s.tokens_out).toLocaleString()} tok
            </span>
            <Tag mono>{(s.model || "").replace("claude-", "")}</Tag>
          </div>
        ))}
      </Section>

      {touched > 0 && (
        <Section title="Tasks touched" count={touched}>
          {tasks.doneToday.map((x) => (
            <div className="row" key={x.id}>
              <Tag color="acc">done</Tag>
              <span className="grow">
                {x.source_id} {x.title}
              </span>
              {x.pr_url && (
                <a href={x.pr_url} target="_blank" rel="noreferrer">
                  PR
                </a>
              )}
            </div>
          ))}
          {tasks.workedOn.map((x) => (
            <div className="row" key={x.id}>
              <Tag status={x.status}>{x.status.replace("_", " ")}</Tag>
              <span className="grow">
                {x.source_id} {x.title}
              </span>
              <Tag mono>
                {tasks.minutesByTask[x.id] ? `~${tasks.minutesByTask[x.id]}m` : ""}
              </Tag>
            </div>
          ))}
        </Section>
      )}

      {tasks.sprints.length > 0 && (
        <Section title="Sprint progress" count={tasks.sprints.length}>
          {tasks.sprints.map((s) => (
            <div className="row" key={s.name}>
              <span className="grow">{s.name}</span>
              <Tag color="acc" mono>
                {s.done}/{s.total} · {s.percent}%
              </Tag>
            </div>
          ))}
        </Section>
      )}

      <Section title="Decisions" count={report.decisions.length}>
        {report.decisions.length === 0 && (
          <Empty msg="no decisions recorded" cmd="lzo eod" />
        )}
        {report.decisions.map((d, i) => (
          <div className="row" key={i}>
            <span className="grow wrap">
              <b>{d.choice}</b>
              <br />
              <span className="dim">{d.rationale}</span>
            </span>
            <Tag>
              {d.proposed_by} → {d.decided_by}
            </Tag>
          </div>
        ))}
      </Section>

      <Section title="Event timeline" count={events.length}>
        {events.length === 0 && (
          <Empty msg="nothing captured yet — the daemon ingests as you work" />
        )}
        {events.slice(-300).map((e) => (
          <TimelineRow e={e} key={e.id} />
        ))}
      </Section>
    </>
  );
}

// keep Avatar referenced for tree-shaking parity with Tasks view usage
void Avatar;
