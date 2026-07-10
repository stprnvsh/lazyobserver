#!/usr/bin/env node
/**
 * lazyobserver MCP server (stdio) — registered user-scope so EVERY Claude
 * Code session (CLI + VS Code) gets these tools:
 *
 *   memory_search  — durable codebase knowledge (hybrid BM25+vector)
 *   work_recall    — past days: journal + real conversation history
 *   memory_save    — persist an insight mid-session
 *   journal_note   — thought-process breadcrumb into today's journal
 *   daily_brief    — read a day's journal
 *
 * Reads hit LanceDB directly (MVCC-safe); writes go through the spool —
 * the daemon stays the single writer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Embedder, Store } from "@lazyobserver/core";

import {
  dailyBrief,
  journalNote,
  memorySave,
  memorySearch,
  tasksToday,
  taskUpdate,
  workRecall,
  type Ctx,
} from "./handlers.js";

export * from "./handlers.js";

async function main(): Promise<void> {
  const store = await Store.open();
  const embedder = new Embedder(); // lazy-loads the local model on first use
  const ctx: Ctx = { store, embedder };

  const server = new McpServer({ name: "lazyobserver", version: "0.1.0" });
  const text = (t: string): { content: { type: "text"; text: string }[] } => ({
    content: [{ type: "text", text: t }],
  });

  server.tool(
    "memory_search",
    "Search lazyobserver's durable codebase memory (decisions, gotchas, runbooks, features) with hybrid keyword+semantic retrieval. Use for 'how does X work', 'why was Y chosen', exact identifiers/error strings.",
    {
      query: z.string().describe("what to look for — phrasing or exact identifiers"),
      repo: z.string().optional().describe("filter to one repo path"),
      kind: z
        .enum(["decision", "feature", "gotcha", "runbook", "reference", "preference"])
        .optional(),
      k: z.number().int().min(1).max(25).optional(),
      include_superseded: z.boolean().optional(),
    },
    async (args) => text(await memorySearch(ctx, args)),
  );

  server.tool(
    "work_recall",
    "Search past work: daily journals AND actual conversation history. Use for 'what did we do on Tuesday', 'how did we fix X last week', 'what was discussed about Y'.",
    {
      query: z.string(),
      date_from: z.string().optional().describe("YYYY-MM-DD"),
      date_to: z.string().optional().describe("YYYY-MM-DD"),
      k: z.number().int().min(1).max(25).optional(),
    },
    async (args) => text(await workRecall(ctx, args)),
  );

  server.tool(
    "memory_save",
    "Persist a durable insight about the codebase (a gotcha found, a decision made, how something works). Saved immediately — don't wait for end of day.",
    {
      kind: z.enum(["decision", "feature", "gotcha", "runbook", "reference", "preference"]),
      title: z.string(),
      body: z.string().describe("the full insight; markdown ok"),
      repo: z.string().optional().describe("repo path this belongs to"),
      scope: z.enum(["repo", "workspace", "global"]).optional(),
      supersedes: z.string().optional().describe("id of a memory this replaces"),
    },
    async (args) => text(await memorySave(ctx, args)),
  );

  server.tool(
    "journal_note",
    "Drop a thought-process breadcrumb into today's work journal (reasoning, trade-offs weighed, why an approach was picked/rejected). Feeds the daily report.",
    {
      text: z.string(),
      title: z.string().optional(),
    },
    async (args) => text(await journalNote(ctx, args)),
  );

  server.tool(
    "daily_brief",
    "Read a day's journal: the composed day document plus all notes.",
    { date: z.string().optional().describe("YYYY-MM-DD, default today") },
    async (args) => text(await dailyBrief(ctx, args)),
  );

  server.tool(
    "tasks_today",
    "List open tasks (unified ClickUp + GitHub list). Use when asked what's on the plate / in the sprint. Filter by assignee name to see one person's tasks.",
    { assignee: z.string().optional().describe("only tasks assigned to this name") },
    async (args) => text(await tasksToday(ctx, args)),
  );

  server.tool(
    "task_update",
    "Record a task status transition locally (todo/in_progress/review/done/blocked) with an optional journal comment. The authoritative two-way push happens via `lzo tasks done <id>`.",
    {
      ref: z.string().describe("task id or source id (e.g. github:owner/repo#12)"),
      status: z.enum(["todo", "in_progress", "review", "done", "blocked"]),
      comment: z.string().optional(),
    },
    async (args) => text(await taskUpdate(ctx, args)),
  );

  await server.connect(new StdioServerTransport());
}

// only run as a server when executed directly (bin), not when imported
if (
  process.argv[1] &&
  (process.argv[1].endsWith("mcp/dist/index.js") ||
    process.argv[1].endsWith("lazyobserver-mcp"))
) {
  main().catch((err) => {
    console.error("[mcp] fatal:", err);
    process.exit(1);
  });
}
