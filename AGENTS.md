# AGENTS.md

This file describes how to work safely and consistently in the opencode-editor repository. It applies to the whole repository. More specific `AGENTS.md` files, if added later, override it within their directories.

This is working guidance, not a product specification. Derive feature behavior from the task and relevant tests. Verify current behavior in code before relying on documentation.

## Repository overview

opencode-editor is a Bun + TypeScript web app (zero npm dependencies) that
inspects and edits the live opencode database (`opencode.db`) so resumed
opencode sessions load altered history and context. The server default port is
`4097` (opencode itself uses `4096`).

The implementation files are:

- `src/server.ts`: `Bun.serve` router — the whole REST API plus static-file
  serving for the UI. All endpoints return `{ data }` on success or
  `{ error: { message } }` on failure; keep that envelope consistent.
- `src/db.ts`: connection, read queries, transactions, id generation, and
  backups. Handler-specific writes live in `src/server.ts` under
  `writeTxn()` + `ensureBackup()`.
- `src/history.ts`: port of opencode's `filterCompacted` projection, the
  `len(JSON)/4` token estimate, and the tail-start suggester. Pure functions
  over hydrated messages; never mutates durable history.
- `src/validate.ts`: payload validators (part types, message roles, session
  patch allowlist). All writes validate before touching the database.
- `public/`: dependency-free single-page UI (`index.html`, `app.js`,
  `styles.css`) served as static files. `esc()` must wrap every remote value
  inserted into the DOM.
- `test/roundtrip.test.ts`: `bun:test` suite against an in-memory fixture
  database. Never point tests at the real `opencode.db`.

There is no frontend package manager, no ORM, and no migration system: the
app reads and writes opencode's own schema in place.

## Toolchain and dependencies

- Use Bun 1.4.x (`bun`; ensure it is on `PATH`). `package.json`
  is authoritative and intentionally dependency-free.
- The only database driver is `bun:sqlite` (built in). Do not add
  `better-sqlite3`, `drizzle`, or any other dependency unless the task
  justifies the maintenance cost.
- TypeScript runs directly under Bun with no `tsconfig`; `bun run build`
  compiles the server to `./opencode-editor` (ignored).
  Keep types lightweight and local to each module.

## Build and run

Run the server directly:

```sh
bun src/server.ts
# → http://localhost:4097
```

Environment:

```sh
PORT=4097                              # default 4097
OPENCODE_DB=/tmp/e2e-opencode.db       # override db path for safe experiments
XDG_DATA_HOME=~/.local/share           # base data dir resolution
```

Only one server may hold the port. Before restarting, stop the old instance
first — a stale process keeps serving old code while new instances fail to
bind:

```sh
pgrep -af "bun src/server.ts"
kill <pid>
```

For write-path experiments, copy the database with a consistent snapshot and
point `OPENCODE_DB` at the copy; never exercise untested writes against the
live database:

```sh
sqlite3 ~/.local/share/opencode/opencode.db ".backup '/tmp/e2e-opencode.db'"
OPENCODE_DB=/tmp/e2e-opencode.db PORT=4098 bun src/server.ts
```

## Required verification

Run the narrowest relevant test while iterating, then run the repository gate before reporting completion:

```sh
bun test
```

`bun test` runs the full `test/` suite against an in-memory fixture; it must
stay green and must never require the real database. For server changes, also
smoke-test the boot contract the UI depends on:

```sh
bun src/server.ts & sleep 2
curl -s localhost:4097/api/meta | head -c 120
curl -s "localhost:4097/api/sessions?limit=1" | head -c 120
kill %1
```

Do not claim a check passed unless it was run in the current worktree and its exit status was observed.

## TypeScript and SQL conventions

- ESM `import` syntax throughout; Bun provides `Bun.serve`, `Bun.file`, and
  `bun:sqlite` globals-free via explicit imports.
- Open read-write with plain `new Database(dbPath)` (existence is checked
  first). Explicit `create: false` flags are rejected with `SQLITE_MISUSE`
  on current Bun builds.
- `bun:sqlite` named parameters must be bound explicitly
  (`.run({ $sid: sid })`). Bare `$var` object shorthands reference
  nonexistent `$`-prefixed variables and fail at runtime.
- New row ids match opencode's shape (`ses_`/`msg_`/`prt_` + 26 chars) via
  `newId()` in `src/db.ts`. Do not invent id formats inline.
- All timestamps are millisecond-epoch integers (`nowMs()`).
- `data` JSON columns keep their full opencode shape; validators guard only
  the fields the editor may touch. A part's `type` must never change via
  edit — delete and recreate instead.
- Preserve the `{ data }` / `{ error: { message } }` envelope on every
  endpoint. The homepage once hung on "connecting…" because `/api/meta`
  returned a bare object; the UI destructures `{ data }` unconditionally.

## Module-specific patterns

### Database (`src/db.ts` + writes in `src/server.ts`)

`listMessages()` hydrates messages with their parts and
attaches non-persisted meta keys (`id`, `sessionID`, `messageID`,
`time_created`, `time_updated`); the UI strips them via `cleanForSave()`
before sending `data` back, and the server re-validates. `writeTxn()`
wraps every mutation; `ensureBackup()` throttles `VACUUM INTO` snapshots.
Writes also `touchSession()` so opencode's ordering stays coherent.

### History projection (`src/history.ts`)

`filterCompacted()` ports opencode's `MessageV2.filterCompacted`, whose input
is **newest-first** (`MessageV2.stream()` order). Callers pass oldest-first
arrays, so the port reverses internally before scanning; do not "simplify"
that reversal away. `hiddenCount` is `totalMessages - result.length` (rows
dropped by the early break at the retained tail), not the tail index.
`estimatedTokens` and `suggestTailStart` mirror opencode's `len/4` heuristic
and tail-turn walk. Keep this module pure and free of database imports so it
stays unit-testable.

### Server (`src/server.ts`)

Keep handlers thin: parse, validate, `ensureBackup()`, `writeTxn()`,
respond. Return 404 for unknown sessions/messages/parts, 409 on
`expectedUpdated` mismatch (optimistic concurrency), and 503 on
`SQLITE_BUSY` so the UI can retry while opencode holds the write lock.
Compaction `POST` only stages a marker — opencode generates the summary on
resume; say so in responses and UI copy. Backup restore closes and reopens
the database handle; it must run with opencode closed.

### Web assets (`public/`)

The UI is plain HTML, CSS, and JavaScript with no build step. Keep it
dependency-free unless a task explicitly changes the frontend approach. Use
`esc()` for every remote value rendered as HTML, and keep API calls on the
`{ data }` contract — `api()` throws on unexpected shapes rather than
rendering partial state.

## Testing conventions

- Use `bun:test` (`describe`/`test`/`expect`); the repository has no
  assertion framework beyond it.
- Build fixture databases in `:memory:` with the minimal schema subset the
  test needs (see `test/roundtrip.test.ts`), exactly as production rows look,
  including `time_created`/`time_updated` and realistic `data` JSON.
- Test externally observable behavior and regressions: hydration shape,
  projection cutoffs and ordering, validator rejections, transaction
  rollback. Avoid tests that merely restate implementation details.
- Keep tests deterministic and independent of the real database, the
  network, and wall-clock time (except `nowMs()`-stamped rows, which tests
  read back rather than assert exactly).

## Secrets and local artifacts

Never commit credentials, databases, or runtime output. The following must
stay untracked (`.gitignore` currently covers only the compiled binary):

- `editor-backups/` (created next to the database in use — including
  `/tmp/editor-backups/` during scratch experiments)
- `*.db`, `*.db-shm`, and `*.db-wal`
- `node_modules/` (should never exist in this repo)
- Local server logs and pid files under `/tmp`

The real `~/.local/share/opencode/opencode.db` is live user data: read it
freely, but perform write verification against `.backup` copies via
`OPENCODE_DB` unless the task explicitly requires otherwise.

## Documentation roles

- `README.md` describes current user-visible behavior, commands, and deployment boundaries. Update it when those change.

Do not use this `AGENTS.md` as evidence that a proposed algorithm or feature is correct. Novel behavior still needs a clear task, relevant design or ADR context, tests, and review.

## Change discipline

- Inspect `git status` before editing and preserve unrelated user changes.
- Keep changes scoped to the task.
- Update code, tests, and user documentation together when a public contract changes.
- Do not commit unless requested. When asked to commit, follow the repository's existing descriptive message style (summary line plus body).
- Before handoff, inspect `git diff --check`, review the complete diff, and report the exact verification commands that passed.
