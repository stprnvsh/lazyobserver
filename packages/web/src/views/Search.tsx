import { useState } from "react";

import { api, type MemoryHit, type MessageHit } from "../api";
import { Empty, Loading, Section, Tag } from "../components";

export function Search() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    memory: MemoryHit[];
    messages: MessageHit[];
  } | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResult(await api.search(q));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        className="search"
        autoFocus
        placeholder="Search memory and conversations — semantic + exact identifiers… (Enter)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
      />
      {busy && <Loading label="searching" />}
      {result && !busy && (
        <>
          <Section title="Codebase memory" count={result.memory.length}>
            {result.memory.length === 0 && <Empty msg="no memory hits" />}
            {result.memory.map((m, i) => (
              <div className="row" key={i}>
                <Tag color="acc">{m.kind}</Tag>
                <span className="grow wrap">
                  <b>{m.title}</b>
                  <br />
                  <span className="dim">{m.body.slice(0, 280)}</span>
                </span>
              </div>
            ))}
          </Section>
          <Section title="Conversations" count={result.messages.length}>
            {result.messages.length === 0 && <Empty msg="no conversation hits" />}
            {result.messages.map((m, i) => (
              <div className="row" key={i}>
                <Tag color={m.role === "user" ? "acc" : "blue"}>{m.role}</Tag>
                <span className="grow wrap dim">{m.content.slice(0, 280)}</span>
                <span className="faint meta" style={{ fontFamily: "var(--mono)" }}>
                  {new Date(m.ts).toISOString().slice(0, 10)}
                </span>
              </div>
            ))}
          </Section>
        </>
      )}
    </>
  );
}
