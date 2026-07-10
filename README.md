# lazyobserver

Local-first observability, memory and reporting for Claude Code work.

lazyobserver records everything you and your agents do across Claude Code
(CLI, VS Code, and tool-launched sessions), keeps two memory planes — durable
**codebase memory** (what the code is and why) and a **daily journal** (what
was discussed, decided, and by whom) — and generates end-of-day reports with
task status pulled from ClickUp and GitHub Issues.

Everything stays on your machine: an embedded LanceDB store with fully local
embeddings (transformers.js/ONNX). No data leaves the device except explicit
report exports and task-status sync you opt into.

## Status — M1 (foundation)

| Milestone | Contents | State |
|---|---|---|
| M1 Foundation | monorepo, config/registry, LanceDB store, local embeddings, `init`/`doctor` | ✅ |
| M2 Capture | hooks, spool, daemon, transcript watcher, OTLP receiver, launchd | ✅ |
| M3 Memory | MCP server, SessionStart brief, EOD distiller, MEMORY.md projection, importer, `ask` | ✅ |
| M4 Tasks | ClickUp + GitHub adapters, two-way sync, `tasks`/`work`/`link`, MCP task tools | ✅ |
| M5 Reports + Web | report generator (md/html/json), local dashboard, exports | ✅ |
| M6 Polish | profiles/workspaces UX, redaction toggle, docs | ⬜ |

## Quick start

```bash
npm install
npm run build

node packages/cli/dist/index.js init
node packages/cli/dist/index.js doctor

# or link globally:
npm link -w lazyobserver
lzo init && lzo doctor
```

## Commands (M1)

```
lzo init                                        # set up ~/.lazyobserver
lzo doctor [--no-model]                         # verify everything, incl. M2 readiness
lzo status                                      # config + store row counts
lzo profile add <name> --config-dir <path>      # Claude account profiles (auth only)
lzo workspace add <name> --repos a,b --profile p
lzo workspace repo add <workspace> <path>
lzo workspace use <name>
```

## Layout

```
~/.lazyobserver/          # user-level home (override: LAZYOBSERVER_HOME)
├── config.json           # profiles, workspaces, settings
├── db/                   # LanceDB — events, messages, sessions, tasks,
│                         #   codebase_memory, memory_chunks, daily_memory,
│                         #   decisions, artifacts
├── spool/                # hook-emitted events pending ingest (M2)
├── exports/              # generated reports
├── models/               # cached local embedding model
└── logs/
```

## Architecture invariants

- **Single writer.** LanceDB on a local filesystem is not safe for concurrent
  writers. In M1 the CLI writes directly; from M2 the daemon is the only
  writer and everything else reads (MVCC) or goes through its socket.
- **Local embeddings.** all-MiniLM-L6-v2 (384-dim) via transformers.js — no
  text leaves the machine to be indexed.
- **Hybrid retrieval.** Every memory search is BM25 + vector fused with RRF —
  exact identifiers (`GS_10253384528`) and semantic phrasing both hit.
- **Parent-child retrieval.** Docs are chunked by markdown heading structure;
  search hits chunks, results return whole parent records.

## Development

```bash
npm run build        # core then cli
npm test             # builds, then runs all workspace tests
```
