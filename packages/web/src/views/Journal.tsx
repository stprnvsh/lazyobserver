import { useEffect, useState } from "react";

import { api, type JournalRow } from "../api";
import { Empty, Loading, Section } from "../components";

export function Journal({ date }: { date: string }) {
  const [rows, setRows] = useState<JournalRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api.journal(date).then(setRows).catch(() => setRows([]));
  }, [date]);

  if (!rows) return <Loading />;
  const doc = rows.find((r) => r.kind === "day_doc");
  const notes = rows
    .filter((r) => r.kind === "entry")
    .sort((a, b) => a.created_at - b.created_at);

  return (
    <>
      <Section title="Day document" count={doc ? 1 : 0}>
        {doc ? (
          <div style={{ padding: "8px 0" }}>
            <b style={{ fontSize: 15 }}>{doc.title}</b>
            <div style={{ height: 10 }} />
            <pre>{doc.body}</pre>
          </div>
        ) : (
          <Empty msg="no day document yet" cmd="lzo eod" />
        )}
      </Section>
      <Section title="Notes" count={notes.length}>
        {notes.length === 0 && (
          <Empty msg="no journal notes — agents write them via journal_note" />
        )}
        {notes.map((n) => (
          <div className="row" key={n.id}>
            <span className="grow wrap">
              {n.title && (
                <>
                  <b>{n.title}</b>
                  <br />
                </>
              )}
              <span className="dim">{n.body}</span>
            </span>
          </div>
        ))}
      </Section>
    </>
  );
}
