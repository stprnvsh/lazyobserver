import { useState } from "react";

import { Journal } from "./views/Journal";
import { Search } from "./views/Search";
import { Tasks } from "./views/Tasks";
import { Today } from "./views/Today";

const VIEWS = ["today", "tasks", "journal", "search"] as const;
type View = (typeof VIEWS)[number];

const LABELS: Record<View, string> = {
  today: "Today",
  tasks: "Tasks",
  journal: "Journal",
  search: "Search",
};

function localDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

export default function App() {
  const [view, setView] = useState<View>("today");
  const [date, setDate] = useState<string>(localDate());

  return (
    <>
      <header>
        <div className="brand">
          <span className="dot" />
          lazy<em>observer</em>
        </div>
        <nav>
          {VIEWS.map((v) => (
            <button
              key={v}
              className={view === v ? "on" : ""}
              onClick={() => setView(v)}
            >
              {LABELS[v]}
            </button>
          ))}
        </nav>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value || localDate())}
        />
        <div className="spacer" />
        <div className="exports">
          <span>export</span>
          <a href={`/export/${date}.md`}>md</a>
          <a href={`/export/${date}.html`}>html</a>
          <a href={`/export/${date}.json`}>json</a>
        </div>
      </header>
      <main>
        {view === "today" && <Today date={date} />}
        {view === "tasks" && <Tasks />}
        {view === "journal" && <Journal date={date} />}
        {view === "search" && <Search />}
      </main>
    </>
  );
}
