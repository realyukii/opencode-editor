# opencode-editor

A local web app for inspecting and editing the database behind
[opencode](https://opencode.ai) (`opencode.db`) — the SQLite store where
opencode keeps every session's transcript, tool calls, todos, and context
state.

## Why this exists

opencode persists the full conversation in `~/.local/share/opencode/opencode.db`,
but what the model actually receives on each turn is a *projection* of that
history: older turns can be replaced by a compaction summary, tool outputs get
truncated, and system context is rebuilt per turn. There is no built-in way to
see that projection, fix a bad tool result, rewrite a message, or re-target a
compaction — so this editor exposes both layers:

* **Durable transcript** — every `message`/`part` row, editable as JSON.
* **Model context** — the filtered, reordered request the model would receive,
  computed with a faithful port of opencode's own `filterCompacted` logic.

Edit the transcript here, resume the session in opencode, and the altered
context is what gets loaded.

## Features

### Browse & search sessions
* Session list with message counts, token usage, cost, and compaction badges.
* Substring search over title, slug, directory, and id; filter by project.
* Project list derived from the `project` table (worktree paths).

### Transcript editing (`message` / `part` tables)
* View every message with its typed parts (`text`, `reasoning`, `tool`,
  `file`, `compaction`, `subtask`, …) and per-part previews.
* Edit any part's `data` JSON in place, with type validation.
* Add/delete messages and parts. New ids match opencode's
  `ses_`/`msg_`/`prt_` shape.
* Toggle visibility of tool calls and reasoning while reading.
* Safety rails: a part's `type` cannot be changed via edit
  (delete + recreate instead), and stale edits are rejected with HTTP 409 —
  reload and retry.

### Model-context projection
* Shows what the model receives vs the full stored transcript:
  projected order, hidden (summarized-away) count, and token estimate
  using opencode's `len(JSON)/4` heuristic.
* Tail-start suggester: given a keep budget (default 15 000 tokens),
  proposes the message id where a new compaction's retained tail should start.

### Compaction management
* Insert a compaction marker with a chosen `tail_start_id` — resume the
  session in opencode and it generates the summary on the next loop.
* Remove the latest compaction marker plus its summary ("uncompact"),
  restoring the full history to the active context.

### Context epoch & V2 tables (forward-compatible)
* Read `session_message`, `session_input`, and `session_context_epoch`
  (empty on opencode 1.x's V1 runtime, populated on the dev branch).
* Create, edit, or clear the epoch baseline/snapshot; clearing forces a
  fresh baseline on the next run.

### Todos & session settings
* Replace a session's todo list.
* Edit title, agent, cost/token counters, and archive/unarchive sessions.

### Backups & live-write safety
* One-click backup (`VACUUM INTO`, throttled, keeps latest 10) before
  writes, plus header-level backup/restore — restore with opencode closed.
* All writes run in transactions with `busy_timeout=5000`, so the editor
  coexists with a running opencode TUI (HTTP 503 + retry on contention).
* Consistent `{ data }` / `{ error: { message } }` API envelope.

## Run

```sh
bun src/server.ts
# → http://localhost:4097
```

| env var | effect |
|---|---|
| `PORT` | default `4097` (opencode itself uses 4096) |
| `OPENCODE_DB` | override db path (`:memory:`, absolute, or relative to data dir) |
| `OPENCODE_CHANNEL` | channel-suffixed db name, mirroring opencode |
| `XDG_DATA_HOME` | base data dir (default `~/.local/share/opencode`) |

## Compile

```sh
bun build src/server.ts --compile --outfile opencode-editor
```

The executable is self-contained: `public/` is embedded at compile time, so
the binary serves the UI from any working directory and does not need the
repository or `public/` alongside it. Running `bun src/server.ts` still reads
`public/` from disk and picks up UI edits without rebuilding.

## API overview

| method & path | purpose |
|---|---|
| `GET /api/meta` | db path, journal mode, table counts |
| `GET /api/projects` | projects |
| `GET /api/sessions…` / `PATCH /api/sessions/:id` | list, read, patch allowlisted fields |
| `GET /api/sessions/:id/messages` | hydrated transcript (`include_tools`, `include_thinking`) |
| `POST /api/sessions/:id/messages` | append message + parts |
| `PATCH /api/messages/:id/data` / `DELETE /api/messages/:id` | edit / delete (cascades parts) |
| `POST /api/messages/:id/parts` | add part |
| `PATCH /api/parts/:id/data` / `DELETE /api/parts/:id` | edit / delete part |
| `GET /api/sessions/:id/context` | projected model context + suggestion |
| `POST` / `DELETE /api/sessions/:id/compaction` | stage / remove compaction |
| `GET` / `PUT` / `DELETE /api/sessions/:id/epoch` | V2 context epoch |
| `GET /api/sessions/:id/v2messages`, `/inputs`, `/todos` | V2 reads, todo replace via `PUT` |
| `GET` / `POST /api/backups`, `POST /api/backups/restore` | backup management |

## Project layout

```
src/server.ts    Bun.serve router — the whole REST API + static files
src/db.ts        connection, read queries, transactions, backups; writes live in server.ts handlers
src/history.ts   filterCompacted port, token estimate, tail suggester
src/validate.ts  payload validators (part types, roles, session allowlist)
public/          dependency-free single-page UI (index.html, app.js, styles.css)
test/            bun:test round-trip suite (fixture DB, no live writes)
```

## Test

```sh
bun test   # 9 tests: hydration, compaction projection,
                      # validators, rollback — all against an in-memory fixture
```

## Notes & limits

* Targets opencode 1.18.x (V1 `message`/`part` runtime); V2 tables are
  supported but empty there and ignored by the V1 runner.
* Inserting a compaction marker only *stages* compaction — opencode itself
  writes the summary when the session resumes.
* Editing history is lossy by nature (a new summary supersedes old turns);
  back up first. The editor auto-backs-up, but restore with opencode closed.
