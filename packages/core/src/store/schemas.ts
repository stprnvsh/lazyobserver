/**
 * LanceDB table schemas — the single user-level store for everything:
 * granular events, transcript messages, sessions, tasks, both memory planes,
 * decisions and artifacts.
 *
 * Design notes:
 *  - `vector` columns are FixedSizeList<Float32>[384] (all-MiniLM-L6-v2);
 *    only tables we semantically search carry one. Events are filter/scan
 *    only — their text lives in `messages`.
 *  - `*_chunks` implements parent-child retrieval: search small (chunk),
 *    return big (parent record) — best practice for md/docs search.
 *  - Timestamps are Float64 epoch-ms (easy range filters; ISO derivable).
 *  - JSON payloads are Utf8 columns; LanceDB filters don't reach into them,
 *    so anything filterable gets its own column.
 */
// apache-arrow is @lancedb/lancedb's peer dependency (>=15 <=18.1); schema
// objects must come from the SAME arrow package instance lancedb resolves.
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Schema,
  Utf8,
} from "apache-arrow";

import { EMBEDDING_DIMENSIONS } from "../embeddings.js";

export const TABLES = {
  events: "events",
  messages: "messages",
  sessions: "sessions",
  tasks: "tasks",
  codebaseMemory: "codebase_memory",
  memoryChunks: "memory_chunks",
  dailyMemory: "daily_memory",
  decisions: "decisions",
  artifacts: "artifacts",
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

function utf8(name: string): Field {
  return new Field(name, new Utf8(), true);
}

function f64(name: string): Field {
  return new Field(name, new Float64(), true);
}

function vectorField(): Field {
  return new Field(
    "vector",
    new FixedSizeList(
      EMBEDDING_DIMENSIONS,
      new Field("item", new Float32(), true),
    ),
    true,
  );
}

/** Fully granular trace of everything that happens in a session. */
const eventsSchema = new Schema([
  utf8("id"),
  f64("ts"),
  utf8("session_id"),
  utf8("surface"), // cli | vscode | tool
  utf8("actor"), // user | agent | system
  utf8("kind"), // prompt | tool_call | file_edit | commit | task_update | ...
  utf8("repo"),
  utf8("workspace"),
  utf8("branch"),
  utf8("task_id"),
  utf8("payload"), // JSON
  f64("tokens_in"),
  f64("tokens_out"),
  f64("cost_usd"),
]);

/** Full transcript messages (already chunk-sized; long ones split by seq). */
const messagesSchema = new Schema([
  utf8("id"),
  utf8("session_id"),
  f64("ts"),
  utf8("role"), // user | assistant | tool
  f64("seq"),
  utf8("content"),
  utf8("repo"),
  utf8("profile"),
  vectorField(),
]);

/** Per-session rollup, written at SessionEnd / EOD. */
const sessionsSchema = new Schema([
  utf8("id"),
  f64("started_at"),
  f64("ended_at"),
  utf8("repo"),
  utf8("workspace"),
  utf8("branch"),
  utf8("profile"),
  utf8("surface"),
  utf8("model"),
  f64("tokens_in"),
  f64("tokens_out"),
  f64("cost_usd"),
  utf8("summary"),
  vectorField(),
]);

/** Unified canonical task list (ClickUp + GitHub Issues refs). */
const tasksSchema = new Schema([
  utf8("id"),
  utf8("source"), // clickup | github
  utf8("source_id"),
  utf8("title"),
  utf8("description"),
  utf8("status"), // unified: todo | in_progress | review | done | blocked
  utf8("sprint"),
  utf8("url"),
  utf8("repo"),
  utf8("branch"),
  utf8("pr_url"),
  utf8("assignee"),
  f64("updated_at"),
  f64("synced_at"),
  vectorField(),
]);

/** Durable truth about the code: typed, scoped, lifecycle-managed. */
const codebaseMemorySchema = new Schema([
  utf8("id"),
  utf8("repo"),
  utf8("scope"), // repo | workspace | global
  utf8("kind"), // decision | feature | gotcha | runbook | reference | preference
  utf8("title"),
  utf8("body"),
  utf8("status"), // active | superseded
  utf8("supersedes"),
  f64("created_at"),
  f64("updated_at"),
  utf8("source_session"),
  vectorField(),
]);

/** Parent-child retrieval: chunks of memory docs / day documents. */
const memoryChunksSchema = new Schema([
  utf8("id"),
  utf8("parent_id"),
  utf8("parent_table"), // codebase_memory | daily_memory
  utf8("heading_path"), // "repo > file > h1 > h2"
  f64("seq"),
  utf8("text"),
  vectorField(),
]);

/** The work-narrative plane: journal entries all day + composed day docs. */
const dailyMemorySchema = new Schema([
  utf8("id"),
  utf8("date"), // YYYY-MM-DD
  utf8("kind"), // entry | day_doc
  utf8("workspaces"), // JSON array
  utf8("title"),
  utf8("body"),
  utf8("session_id"),
  f64("created_at"),
  vectorField(),
]);

/** First-class decision records: the "why" the codebase plane can't hold. */
const decisionsSchema = new Schema([
  utf8("id"),
  utf8("date"),
  utf8("session_id"),
  utf8("repo"),
  utf8("context"),
  utf8("options"), // JSON array of considered options
  utf8("choice"),
  utf8("rationale"),
  utf8("proposed_by"), // user | agent
  utf8("decided_by"), // user | agent
  utf8("links"), // JSON (commits, PRs, tasks)
  vectorField(),
]);

/** Reports, exports, images from sessions (path refs; blobs later). */
const artifactsSchema = new Schema([
  utf8("id"),
  f64("ts"),
  utf8("kind"), // report | export | image
  utf8("title"),
  utf8("path"),
  utf8("mime"),
  utf8("meta"), // JSON
]);

export const TABLE_SCHEMAS: Record<TableName, Schema> = {
  [TABLES.events]: eventsSchema,
  [TABLES.messages]: messagesSchema,
  [TABLES.sessions]: sessionsSchema,
  [TABLES.tasks]: tasksSchema,
  [TABLES.codebaseMemory]: codebaseMemorySchema,
  [TABLES.memoryChunks]: memoryChunksSchema,
  [TABLES.dailyMemory]: dailyMemorySchema,
  [TABLES.decisions]: decisionsSchema,
  [TABLES.artifacts]: artifactsSchema,
};

/** text column(s) that get a BM25 FTS index, per table */
export const FTS_COLUMNS: Partial<Record<TableName, string[]>> = {
  [TABLES.messages]: ["content"],
  [TABLES.sessions]: ["summary"],
  [TABLES.tasks]: ["title", "description"],
  [TABLES.codebaseMemory]: ["title", "body"],
  [TABLES.memoryChunks]: ["text"],
  [TABLES.dailyMemory]: ["title", "body"],
  [TABLES.decisions]: ["context", "choice", "rationale"],
};
