import type { ReactNode } from "react";

export function Section(props: {
  title: string;
  count: number | string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2>
        {props.title}
        <span className="count">{props.count}</span>
      </h2>
      <div className="body">{props.children}</div>
    </section>
  );
}

export function Card(props: { value: ReactNode; label: string; sub?: string }) {
  return (
    <div className="card">
      <b>{props.value}</b>
      <span>{props.label}</span>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  in_progress: "acc",
  review: "amber",
  blocked: "red",
};

export function Tag(props: {
  children: ReactNode;
  color?: string;
  status?: string;
  mono?: boolean;
}) {
  const color = props.color ?? (props.status ? STATUS_COLOR[props.status] ?? "" : "");
  return (
    <span className={`tag ${color} ${props.mono ? "mono" : ""}`.trim()}>
      {props.children}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  if (!name) return null;
  const initials = name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  const first = name.split(",")[0];
  const more = name.includes(",");
  return (
    <span className="avatar">
      <i>{initials}</i>
      {first}
      {more ? " +" : ""}
    </span>
  );
}

export function Empty(props: { msg: string; cmd?: string }) {
  return (
    <div className="empty">
      {props.msg}
      {props.cmd && (
        <>
          {" — "}
          <code>{props.cmd}</code>
        </>
      )}
    </div>
  );
}

export function Loading({ label = "loading" }: { label?: string }) {
  return <div className="loading">{label}</div>;
}
