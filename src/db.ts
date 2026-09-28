import { Database } from "bun:sqlite";
import path from "path";
import os from "os";
import fs from "fs";

// ---------------------------------------------------------------------------
// Path resolution (mirrors opencode Database.path())
// ---------------------------------------------------------------------------
export function resolveDbPath(): string {
  const override = process.env.OPENCODE_DB;
  const dataDir =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share", "opencode");
  if (override) {
    if (override === ":memory:") return override;
    if (path.isAbsolute(override)) return override;
    return path.join(dataDir, override);
  }
  if (
    ["latest", "beta", "prod"].includes(process.env.OPENCODE_CHANNEL ?? "") ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true" ||
    !process.env.OPENCODE_CHANNEL
  )
    return path.join(dataDir, "opencode.db");
  const safe = process.env.OPENCODE_CHANNEL!.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(dataDir, `opencode-${safe}.db`);
}

export function backupDir(): string {
  return path.join(path.dirname(resolveDbPath()), "editor-backups");
}

// ---------------------------------------------------------------------------
// Open (WAL-safe for live opencode coexistence)
// ---------------------------------------------------------------------------
export function openDb(dbPath: string, readonly = false): Database {
  if (dbPath !== ":memory:" && !fs.existsSync(dbPath))
    throw new Error(`opencode.db not found at ${dbPath}`);
  // NB: plain open (read-write). Existence is checked above, so no
  // accidental creation; bun:sqlite rejects explicit create/readonly flags
  // on some builds with SQLITE_MISUSE.
  const db = readonly
    ? new Database(dbPath, { readonly: true })
    : new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// ID generation (matches opencode ses_*/msg_*/prt_* shape: prefix + 26 chars)
// ---------------------------------------------------------------------------
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz";
function suffix26(): string {
  const b = new Uint8Array(26);
  crypto.getRandomValues(b);
  let s = "";
  for (const v of b) s += ALPHABET[v % ALPHABET.length];
  return s;
}
export function newId(prefix: "ses" | "msg" | "prt"): string {
  return `${prefix}_${suffix26()}`;
}
export function nowMs(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------
function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Corrupt JSON in ${what}`);
  }
}

export interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
  time_archived: number | null;
}

export interface MessageWithParts {
  info: Record<string, unknown> & { id: string; sessionID: string; role: string };
  parts: Array<Record<string, unknown> & { id: string; sessionID: string; messageID: string }>;
}

// --- sessions ---------------------------------------------------------------
export function listSessions(
  db: Database,
  opts: { project?: string; q?: string; limit?: number; offset?: number } = {},
) {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.project) {
    conds.push("s.project_id = $project");
    params["$project"] = opts.project;
  }
  if (opts.q) {
    conds.push("(s.title LIKE $q OR s.slug LIKE $q OR s.directory LIKE $q OR s.id = $qid)");
    params["$q"] = `%${opts.q}%`;
    params["$qid"] = opts.q;
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT s.*, p.worktree,
        (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count,
        (SELECT COUNT(*) FROM part t WHERE t.session_id = s.id AND json_extract(t.data,'$.type')='compaction') AS compaction_count
       FROM session s LEFT JOIN project p ON p.id = s.project_id
       ${where} ORDER BY s.time_updated DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({
      ...params,
      $limit: Math.min(opts.limit ?? 50, 200),
      $offset: opts.offset ?? 0,
    }) as Array<SessionRow & { worktree: string | null; message_count: number; compaction_count: number }>;
  return rows;
}

export function getSession(db: Database, id: string) {
  const row = db.query("SELECT * FROM session WHERE id = $id").get({ $id: id }) as SessionRow | null;
  if (!row) return null;
  const model = row.model ? parseJson(row.model, `session ${id} model`) : null;
  return { ...row, model };
}

export function touchSession(db: Database, id: string, now = nowMs()) {
  db.query("UPDATE session SET time_updated = $now WHERE id = $id").run({ $now: now, $id: id });
}

// --- V1 messages/parts -------------------------------------------------------
export function listMessages(db: Database, sessionId: string): MessageWithParts[] {
  const msgRows = db
    .query("SELECT * FROM message WHERE session_id = $sid ORDER BY time_created ASC, id ASC")
    .all({ $sid: sessionId }) as Array<{
    id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
  if (!msgRows.length) return [];
  const ids = msgRows.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const partRows = db
    .query(`SELECT * FROM part WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`)
    .all(...ids) as Array<{
    id: string;
    message_id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
  const byMsg = new Map<string, MessageWithParts["parts"]>();
  for (const p of partRows) {
    const list = byMsg.get(p.message_id) ?? [];
    list.push({ ...parseJson<Record<string, unknown>>(p.data, `part ${p.id}`), id: p.id, sessionID: p.session_id, messageID: p.message_id, time_created: p.time_created, time_updated: p.time_updated });
    byMsg.set(p.message_id, list);
  }
  return msgRows.map((m) => {
    const data = parseJson<Record<string, unknown>>(m.data, `message ${m.id}`);
    return {
      info: { ...data, id: m.id, sessionID: m.session_id, role: String(data.role ?? ""), time_created: m.time_created, time_updated: m.time_updated },
      parts: byMsg.get(m.id) ?? [],
    };
  });
}

// --- V2 tables (empty on 1.18.x, supported for forward-compat) ----------------
export function listSessionMessages(db: Database, sessionId: string, limit = 200) {
  return db
    .query("SELECT * FROM session_message WHERE session_id = $sid ORDER BY seq ASC LIMIT $limit")
    .all({ $sid: sessionId, $limit: Math.min(limit, 1000) });
}

export function getEpoch(db: Database, sessionId: string) {
  return db.query("SELECT * FROM session_context_epoch WHERE session_id = $sid").get({ $sid: sessionId }) as {
    session_id: string;
    baseline: string;
    snapshot: string;
    baseline_seq: number;
  } | null;
}

export function listInputs(db: Database, sessionId: string) {
  return db.query("SELECT * FROM session_input WHERE session_id = $sid ORDER BY admitted_seq ASC").all({ $sid: sessionId });
}

export function listTodos(db: Database, sessionId: string) {
  return db.query("SELECT * FROM todo WHERE session_id = $sid ORDER BY position ASC").all({ $sid: sessionId });
}

export function listProjects(db: Database) {
  return db.query("SELECT id, worktree, name, time_created FROM project ORDER BY time_created DESC").all();
}

// --- backup -------------------------------------------------------------------
export function createBackup(db: Database): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `opencode-${stamp}.db`);
  // quote path for SQL string literal
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  // prune to latest 10
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("opencode-")).sort();
  while (files.length > 10) {
    const old = files.shift()!;
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
  }
  return dest;
}

export function listBackups(): string[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("opencode-")).sort().reverse();
}

// --- write txn helper -----------------------------------------------------------
export function writeTxn<T>(db: Database, fn: () => T): T {
  const txn = db.transaction(fn);
  return txn();
}
