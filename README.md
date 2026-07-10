# lazyobserver

Local-first observability, memory and reporting for Claude Code work.

lazyobserver records everything you and your agents do across Claude Code
(CLI, VS Code extension, and tool-launched sessions), keeps two memory
planes — durable **codebase memory** (what the code is and why) and a
**daily journal** (what was discussed, decided, and by whom) — syncs your
**tasks** two-way with ClickUp and GitHub Issues, and generates **daily
reports** and a **local web dashboard** with full observability.

Everything stays on your machine: an embedded LanceDB store with fully local
embeddings (transformers.js/ONNX). Nothing leaves the device except the task
status/comments you explicitly push and report exports you choose to share.

## Status

| Milestone | Contents | State |
|---|---|---|
| M1 Foundation | monorepo, config/registry, LanceDB store, local embeddings, `init`/`doctor` | ✅ |
| M2 Capture | hooks, spool, daemon, transcript watcher, OTLP receiver, launchd | ✅ |
| M3 Memory | MCP server, SessionStart brief, EOD distiller, MEMORY.md projection, importer, `ask` | ✅ |
| M4 Tasks | ClickUp + GitHub adapters, two-way sync, sprints, `--mine`, `tasks`/`work`/`link`, MCP task tools | ✅ |
| M5 Reports + Web | report generator (md/html/json), local dashboard, exports | ✅ |
| M6 Polish | workspace/profile management, redaction toggle, docs | ✅ |

## Install

```bash
git clone https://github.com/stprnvsh/lazyobserver && cd lazyobserver
npm install && npm run build
npm link -w lazyobserver        # provides `lazyobserver` and `lzo`
```

## Setup (one time)

```bash
lzo init                                          # dirs, config, store, local embedding model
lzo profile add work --config-dir ~/.claude       # a profile = one Claude account
lzo workspace add myws --repos ~/repo1,~/repo2 --profile work
lzo workspace use myws

lzo capture install       # hooks + telemetry into every profile's settings.json (backed up)
lzo daemon install-launchd # collector survives reboots (or: lzo daemon start)
lzo mcp install            # memory/task tools in every new Claude session
lzo import claude-memory   # optional: migrate existing auto-memory markdown

lzo doctor                 # verifies every piece end-to-end
```

From that moment every Claude Code session — any repo, CLI or VS Code — is
captured continuously. New sessions open with a context brief (last day doc,
today's notes, the repo's top memories) and carry the MCP tools.

## Daily flow

```bash
lzo tasks sync             # pull ClickUp + GitHub (two-way base state)
lzo tasks --mine           # what's on MY plate (identity auto-resolved)
lzo work 86caeepxm         # launch claude on a task: right repo, pinned
                           #   profile, context injected, events task-tagged

# ... work all day, everything is captured ...

lzo tasks done 86caeepxm   # push: source status -> done + completion comment
lzo eod                    # distill the day -> journal + memory + decisions
lzo report --export html   # the daily observability report
lzo web                    # dashboard: today / tasks / journal / search
```

## Command reference

### Setup & health
| Command | What it does |
|---|---|
| `lzo init` | create `~/.lazyobserver` (dirs, config, LanceDB tables, embedding model) |
| `lzo doctor [--no-model]` | verify install: store, model, hooks, telemetry, daemon, transcripts |
| `lzo status` | config summary, store row counts, capture health, spool backlog |

### Profiles & workspaces
| Command | What it does |
|---|---|
| `lzo profile add <name> --config-dir <path>` | register a Claude account (auth only) |
| `lzo profile list` | profiles + which workspaces pin them |
| `lzo profile remove <name>` | refuses while a workspace pins it |
| `lzo workspace add <name> [--repos a,b] [--profile p]` | named set of repo folders |
| `lzo workspace show <name>` | repos, pinned profile, task connections |
| `lzo workspace use / list / remove <name>` | manage workspaces |
| `lzo workspace pin/unpin <ws> [profile]` | company code never runs on a personal account |
| `lzo workspace repo add/remove <ws> <path>` | a repo may belong to several workspaces |

### Capture
| Command | What it does |
|---|---|
| `lzo capture install` | hook script + SessionStart brief + OTel env into every profile (non-destructive, backed up) |
| `lzo capture uninstall` | removes exactly ours; user settings survive |
| `lzo daemon start/stop/status` | the collector — the ONLY LanceDB writer |
| `lzo daemon install-launchd / uninstall-launchd` | keep it alive across reboots |

### Memory
| Command | What it does |
|---|---|
| `lzo ask "<question>"` | hybrid recall across codebase memory, journals, conversations |
| `lzo eod [--date] [--offline]` | distill the day: day doc + memory upserts + decisions + MEMORY.md projections + export |
| `lzo brief` | the SessionStart context block (hooks call this automatically) |
| `lzo import claude-memory` | migrate `~/.claude/projects/*/memory/*.md` (idempotent) |

MCP tools available in every session: `memory_search`, `work_recall`,
`memory_save`, `journal_note`, `daily_brief`, `tasks_today`, `task_update`.

### Tasks
| Command | What it does |
|---|---|
| `lzo connect clickup [--token k] [--team id] [--lists ids] [--sprint-folders ids] [--browse]` | API key only is enough — team auto-discovered; `--browse` prints spaces/folders/lists |
| `lzo connect github --repos owner/a,owner/b` | rides your existing `gh` auth |
| `lzo tasks sync` | pull all sources (paginated; sprints resolve the CURRENT list by date; multi-list tasks included) |
| `lzo tasks [--mine] [--assignee name] [--today] [--all]` | the unified list |
| `lzo tasks show/start/done/link <ref>` | detail / push in-progress / push done + comment with branch+PR / attach cwd+branch |
| `lzo work <ref>` | launch claude on the task (pinned profile, context injected, events tagged) |

### Reports & dashboard
| Command | What it does |
|---|---|
| `lzo report [--date] [--export md\|html\|json]` | worked-on + completed tasks, sprint progress, per-task time, sessions/tokens/cost, user-vs-agent split, decisions, day doc |
| `lzo web [--port]` | React dashboard at 127.0.0.1:43180 — Today (expandable event timeline) / Tasks (assignee filter) / Journal / Search + exports |

### Redaction
| Command | What it does |
|---|---|
| `lzo redaction on/off/status` | opt-in secret scrubbing (default OFF — everything is local anyway) |

When ON, secrets are scrubbed at **capture time** (event payloads, transcript
messages, memory writes) and **export time** (reports, day docs): AWS key ids,
GitHub/Slack/ClickUp/OpenAI tokens, JWTs, `Bearer` headers, URL-embedded
credentials, private-key blocks, and generic `password=`/`token:` assignments.
Not retroactive — rows captured before enabling stay as they were.

## Architecture

```
~/.lazyobserver/
├── config.json         # profiles, workspaces, connections, settings
├── db/                 # LanceDB: events, messages, sessions, tasks,
│                       #   codebase_memory, memory_chunks, daily_memory,
│                       #   decisions, artifacts
├── spool/              # hook events + memory writes pending ingest
├── exports/            # reports and day docs
├── models/             # cached local embedding model
├── bin/                # hook + brief scripts
└── logs/
```

**Capture** (three redundant paths): user-level Claude Code hooks spool every
event (atomic per-event files, `exit 0` always — a hook can never break a
session); the daemon tails every profile's transcript JSONLs with persisted
byte offsets (no historic backfill — import is explicit); an OTLP receiver
takes per-request token/cost telemetry.

**Single writer**: LanceDB on a local filesystem is not safe for concurrent
writers. The daemon is the only process that writes; the CLI, MCP server, web
app and eod queue writes through the spool and read directly (MVCC-safe).

**Memory**: LanceDB is canonical; retrieval is hybrid (BM25 + vector + RRF)
so exact identifiers and semantic phrasing both hit; embeddings are computed
on-device (all-MiniLM-L6-v2, 384-dim). `MEMORY.md` projections keep native
Claude Code auto-memory working (only a marked block is ever touched).
The EOD distiller runs one `claude -p` call on your own account (`--offline`
for a mechanical day doc with zero LLM).

**Tasks**: unified model (`source:id`), one status vocabulary, two-way —
pulls paginate past ClickUp's 100/page cap and use `include_timl` so tasks
living in multiple lists count as sprint members; sprint FOLDERS are stored
and the current sprint list resolves by date at each sync; pushes respect
each list's own status vocabulary and comment with branch/PR.

## Troubleshooting

- `lzo doctor` first — every check is real.
- Capture not flowing? `lzo daemon status` (heartbeat + counters), then
  `~/.lazyobserver/logs/daemon.log`. Hooks apply to sessions started AFTER
  `lzo capture install`.
- Spool backlog growing? The daemon is down — launchd restarts it, or
  `lzo daemon start`.
- Search misses fresh rows? BM25 joins within one maintenance cycle (5 min);
  vector search covers new rows immediately.
- Wrong/stale sprint? The current sprint list is picked by date range —
  `lzo connect clickup --browse` shows what the folder contains.

## Uninstall

```bash
lzo capture uninstall && lzo mcp uninstall
lzo daemon uninstall-launchd && lzo daemon stop
rm -rf ~/.lazyobserver          # the data
```

## Development

```bash
npm run build   # core -> daemon -> mcp -> cli -> web (Vite/React)
npm test        # builds, then runs every workspace's suite

# frontend dev mode (hot reload, proxies the API):
npm run dev -w @lazyobserver/web
```

Strict TDD: every test encodes a real requirement; capture fixtures mirror
real transcript/hook/API shapes observed live.
