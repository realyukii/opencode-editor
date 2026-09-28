import path from "path";
import fs from "fs";
import { Database } from "bun:sqlite";
import {
  resolveDbPath, openDb, backupDir, createBackup, listBackups,
  listSessions, getSession, touchSession, listMessages,
  listSessionMessages, getEpoch, listInputs, listTodos, listProjects,
  newId, nowMs, writeTxn,
} from "./db";
import { filterCompacted, estimateTokens, suggestTailStart } from "./history";
import { assertRecord, validatePartData, validateMessageData, validateSessionPatch } from "./validate";

const PORT = Number(process.env.PORT ?? 4097);
const DB_PATH = resolveDbPath();
const PUBLIC = path.join(import.meta.dir, "..", "public");

// Single handle; reopened after restore.
let db: Database = openDb(DB_PATH);
let lastBackupAt = 0;
function ensureBackup(): string {
  if (Date.now() - lastBackupAt < 15 * 60 * 1000) {
    const existing = listBackups();
    if (existing.length) return path.join(backupDir(), existing[0]!);
  }
  const dest = createBackup(db);
  lastBackupAt = Date.now();
  return dest;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function err(message: unknown, status = 400): Response {
  return json({ error: { message: String((message as Error)?.message ?? message) } }, status);
}
async function body(req: Request): Promise<Record<string, unknown>> {
  // DELETEs typically carry no body — treat empty/unparsable as {} and let
  // downstream validation produce specific errors for real payloads.
  const v: unknown = await req.json().catch(() => ({}));
  assertRecord(v, "body");
  return v;
}
function busyGuard(fn: () => Response): Response {
  try {
    return fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("SQLITE_BUSY") || msg.includes("locked")) return err("Database is busy (opencode is writing). Retry.", 503);
    return err(msg, 400);
  }
}
function mustSession(id: string) {
  const s = getSession(db, id);
  if (!s) throw new Error(`Session not found: ${id}`);
  return s;
}
function checkFresh(table: string, id: string, expectedUpdated?: unknown) {
  if (expectedUpdated === undefined) return;
  const row = db.query(`SELECT time_updated FROM ${table} WHERE id = $id`).get({ $id: id }) as { time_updated: number } | null;
  if (row && row.time_updated !== Number(expectedUpdated))
    throw Object.assign(new Error("Stale edit: row changed since you loaded it. Reload and retry."), { status: 409 });
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    try {
      // -- meta -------------------------------------------------------------
      if (p === "/api/meta" && m === "GET") {
        const counts: Record<string, number> = {};
        for (const t of ["session", "message", "part", "session_message", "session_context_epoch", "todo", "project"])
          counts[t] = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        return json({ dbPath: DB_PATH, journalMode: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, counts, backups: listBackups().length });
      }
      if (p === "/api/projects" && m === "GET") return json({ data: listProjects(db) });

      // -- sessions ----------------------------------------------------------
      if (p === "/api/sessions" && m === "GET")
        return json({ data: listSessions(db, { project: url.searchParams.get("project") ?? undefined, q: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0) }) });

      let sm = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (sm && m === "GET") {
        const s = getSession(db, decodeURIComponent(sm[1]!));
        return s ? json({ data: s }) : err("Session not found", 404);
      }

      sm = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        const includeTools = url.searchParams.get("include_tools") !== "false";
        const includeThinking = url.searchParams.get("include_thinking") === "true";
        let msgs = listMessages(db, id);
        if (!includeTools || !includeThinking) {
          msgs = msgs.map((msg) => ({
            ...msg,
            parts: msg.parts.filter((pt) => {
              const t = String(pt.type ?? "");
              if (!includeTools && t === "tool") return false;
              if (!includeThinking && t === "reasoning") return false;
              return true;
            }),
          }));
        }
        return json({ data: msgs });
      }

      sm = p.match(/^\/api\/sessions\/([^/]+)\/context$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        const msgs = listMessages(db, id);
        const proj = filterCompacted(msgs);
        const keep = Number(url.searchParams.get("keep_tokens") ?? 15000);
        return json({
          data: {
            projected: proj.projected,
            totalMessages: proj.totalMessages,
            hiddenCount: proj.hiddenCount,
            tailStartId: proj.tailStartId,
            compactionIndex: proj.compactionIndex,
            summaryIndex: proj.summaryIndex,
            estimatedTokens: proj.estimatedTokens,
            suggestion: suggestTailStart(msgs, keep),
          },
        });
      }

      // -- V2 reads -------------------------------------------------------------
      sm = p.match(/^\/api\/sessions\/([^/]+)\/v2messages$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        return json({ data: listSessionMessages(db, id, Number(url.searchParams.get("limit") ?? 200)) });
      }
      sm = p.match(/^\/api\/sessions\/([^/]+)\/epoch$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        return json({ data: getEpoch(db, id) });
      }
      sm = p.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        return json({ data: listInputs(db, id) });
      }
      sm = p.match(/^\/api\/sessions\/([^/]+)\/todos$/);
      if (sm && m === "GET") {
        const id = decodeURIComponent(sm[1]!);
        mustSession(id);
        return json({ data: listTodos(db, id) });
      }

      // -- backups ---------------------------------------------------------------
      if (p === "/api/backups" && m === "GET") return json({ data: listBackups() });
      if (p === "/api/backups" && m === "POST") return busyGuard(() => json({ data: { file: createBackup(db) } }, 201));

      // -- async (body) routes ------------------------------------------------------
      if (m === "PATCH" || m === "POST" || m === "PUT" || m === "DELETE") {
        return await handleWrite(req, url, p, m);
      }

      // -- static --------------------------------------------------------------------
      return serveStatic(p);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return err(e, status);
    }
  },
});

// PATCH session extracted so busyGuard stays sync
function patchSession(id: string, b: unknown): Response {
  assertRecord(b, "body");
  mustSession(id);
  const patch = (b.patch ?? {}) as Record<string, unknown>;
  assertRecord(patch, "patch");
  validateSessionPatch(patch);
  checkFresh("session", id, (b as { expectedUpdated?: unknown }).expectedUpdated);
  if (!Object.keys(patch).length) return err("Empty patch", 400);
  const backup = ensureBackup();
  const now = nowMs();
  writeTxn(db, () => {
    const sets = Object.keys(patch).map((k) => `${k} = $${k}`).join(", ");
    const params: Record<string, unknown> = { $now: now, $id: id };
    for (const [k, v] of Object.entries(patch)) params["$" + k] = v;
    db.query(`UPDATE session SET ${sets}, time_updated = $now WHERE id = $id`).run(params);
  });
  return json({ data: getSession(db, id), backup });
}

async function handleWrite(req: Request, url: URL, p: string, m: string): Promise<Response> {
  const b = await body(req).catch((e) => { throw e; });
  // PATCH session (async body)
  let sm = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (sm && m === "PATCH") return busyGuard(() => patchSession(decodeURIComponent(sm![1]!), b));

  try {
    // POST message
    sm = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sm && m === "POST") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      assertRecord(b.info, "info");
      validateMessageData(b.info as Record<string, unknown>);
      const parts = Array.isArray(b.parts) ? b.parts : [];
      const backup = ensureBackup();
      const now = nowMs();
      const mid = newId("msg");
      writeTxn(db, () => {
        db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($id,$sid,$n,$n,$d)")
          .run({ $id: mid, $sid: sid, $n: now, $d: JSON.stringify(b.info) });
        for (const pd of parts) {
          assertRecord(pd, "part");
          validatePartData(pd);
          db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id,$mid,$sid,$n,$n,$d)")
            .run({ $id: newId("prt"), $mid: mid, $sid: sid, $n: now, $d: JSON.stringify(pd) });
        }
        touchSession(db, sid, now);
      });
      return json({ data: { id: mid }, backup }, 201);
    }

    // message data
    sm = p.match(/^\/api\/messages\/([^/]+)\/data$/);
    if (sm && m === "PATCH") {
      const mid = decodeURIComponent(sm[1]!);
      assertRecord(b.data, "data");
      validateMessageData(b.data);
      checkFresh("message", mid, b.expectedUpdated);
      const backup = ensureBackup();
      const now = nowMs();
      const updated = writeTxn(db, () => {
        const cur = db.query("SELECT session_id FROM message WHERE id=$id").get({ $id: mid }) as { session_id: string } | null;
        if (!cur) throw Object.assign(new Error("Message not found"), { status: 404 });
        db.query("UPDATE message SET data=$d, time_updated=$n WHERE id=$id").run({ $d: JSON.stringify(b.data), $n: now, $id: mid });
        touchSession(db, cur.session_id, now);
        return cur.session_id;
      });
      return json({ data: { id: mid, session_id: updated }, backup });
    }
    sm = p.match(/^\/api\/messages\/([^/]+)$/);
    if (sm && m === "DELETE") {
      const mid = decodeURIComponent(sm[1]!);
      const backup = ensureBackup();
      const now = nowMs();
      writeTxn(db, () => {
        const cur = db.query("SELECT session_id FROM message WHERE id=$id").get({ $id: mid }) as { session_id: string } | null;
        if (!cur) throw Object.assign(new Error("Message not found"), { status: 404 });
        db.query("DELETE FROM part WHERE message_id=$id").run({ $id: mid });
        db.query("DELETE FROM message WHERE id=$id").run({ $id: mid });
        touchSession(db, cur.session_id, now);
      });
      return json({ data: { deleted: mid }, backup });
    }

    // parts
    sm = p.match(/^\/api\/messages\/([^/]+)\/parts$/);
    if (sm && m === "POST") {
      const mid = decodeURIComponent(sm[1]!);
      assertRecord(b.data, "data");
      validatePartData(b.data);
      const backup = ensureBackup();
      const now = nowMs();
      const pid = writeTxn(db, () => {
        const cur = db.query("SELECT session_id FROM message WHERE id=$id").get({ $id: mid }) as { session_id: string } | null;
        if (!cur) throw Object.assign(new Error("Message not found"), { status: 404 });
        const id = newId("prt");
        db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id,$mid,$sid,$n,$n,$d)")
          .run({ $id: id, $mid: mid, $sid: cur.session_id, $n: now, $d: JSON.stringify(b.data) });
        touchSession(db, cur.session_id, now);
        return id;
      });
      return json({ data: { id: pid }, backup }, 201);
    }
    sm = p.match(/^\/api\/parts\/([^/]+)\/data$/);
    if (sm && m === "PATCH") {
      const pid = decodeURIComponent(sm[1]!);
      assertRecord(b.data, "data");
      validatePartData(b.data);
      checkFresh("part", pid, b.expectedUpdated);
      const backup = ensureBackup();
      const now = nowMs();
      writeTxn(db, () => {
        const cur = db.query("SELECT session_id FROM part WHERE id=$id").get({ $id: pid }) as { session_id: string } | null;
        if (!cur) throw Object.assign(new Error("Part not found"), { status: 404 });
        // forbid changing part type via edit (prevents shape corruption); delete+recreate instead
        const old = db.query("SELECT data FROM part WHERE id=$id").get({ $id: pid }) as { data: string };
        const oldType = String((JSON.parse(old.data) as { type?: string }).type ?? "");
        if (String((b.data as Record<string, unknown>).type) !== oldType)
          throw new Error(`Refusing to change part type ${oldType} → ${(b.data as Record<string, unknown>).type}. Delete and recreate instead.`);
        db.query("UPDATE part SET data=$d, time_updated=$n WHERE id=$id").run({ $d: JSON.stringify(b.data), $n: now, $id: pid });
        touchSession(db, cur.session_id, now);
      });
      return json({ data: { id: pid }, backup });
    }
    sm = p.match(/^\/api\/parts\/([^/]+)$/);
    if (sm && m === "DELETE") {
      const pid = decodeURIComponent(sm[1]!);
      const backup = ensureBackup();
      const now = nowMs();
      writeTxn(db, () => {
        const cur = db.query("SELECT session_id FROM part WHERE id=$id").get({ $id: pid }) as { session_id: string } | null;
        if (!cur) throw Object.assign(new Error("Part not found"), { status: 404 });
        db.query("DELETE FROM part WHERE id=$id").run({ $id: pid });
        touchSession(db, cur.session_id, now);
      });
      return json({ data: { deleted: pid }, backup });
    }

    // compaction marker
    sm = p.match(/^\/api\/sessions\/([^/]+)\/compaction$/);
    if (sm && m === "POST") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      const tail = typeof b.tail_start_id === "string" ? b.tail_start_id : null;
      if (tail) {
        const exists = db.query("SELECT id FROM message WHERE id=$id AND session_id=$sid").get({ $id: tail, $sid: sid });
        if (!exists) throw new Error("tail_start_id is not a message in this session");
      }
      const backup = ensureBackup();
      const now = nowMs();
      const mid = writeTxn(db, () => {
        const id = newId("msg");
        const sess = mustSession(sid);
        const rawModel = sess.model as unknown;
        const model = typeof rawModel === "string" ? JSON.parse(rawModel) : (rawModel ?? { providerID: "opencode", id: "unknown" });
        db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($id,$sid,$n,$n,$d)")
          .run({ $id: id, $sid: sid, $n: now, $d: JSON.stringify({ role: "user", agent: sess.agent ?? "build", model, time: { created: now } }) });
        db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id,$mid,$sid,$n,$n,$d)")
          .run({ $id: newId("prt"), $mid: id, $sid: sid, $n: now, $d: JSON.stringify({ type: "compaction", auto: false, overflow: false, ...(tail ? { tail_start_id: tail } : {}) }) });
        touchSession(db, sid, now);
        return id;
      });
      return json({ data: { id: mid, note: "Marker inserted. Resume the session in opencode to generate the summary; the next loop will compact." }, backup }, 201);
    }
    if (sm && m === "DELETE") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      const backup = ensureBackup();
      const removed = writeTxn(db, () => {
        const rows = db.query("SELECT m.id FROM message m JOIN part t ON t.message_id=m.id WHERE m.session_id=$sid AND json_extract(t.data,'$.type')='compaction' ORDER BY m.time_created DESC, m.id DESC LIMIT 1")
          .all({ $sid: sid }) as Array<{ id: string }>;
        if (!rows.length) throw Object.assign(new Error("No compaction marker in this session"), { status: 404 });
        const mid = rows[0]!.id;
        // remove marker + its summary child (assistant with parentID=marker and summary=true)
        const kids = db.query("SELECT id, data FROM message WHERE session_id=$sid").all({ $sid: sid }) as Array<{ id: string; data: string }>;
        const summaryKids = kids.filter((k) => {
          try {
            const d = JSON.parse(k.data) as { parentID?: string; summary?: boolean };
            return d.parentID === mid && d.summary === true;
          } catch { return false; }
        });
        for (const k of summaryKids) {
          db.query("DELETE FROM part WHERE message_id=$id").run({ $id: k.id });
          db.query("DELETE FROM message WHERE id=$id").run({ $id: k.id });
        }
        db.query("DELETE FROM part WHERE message_id=$id").run({ $id: mid });
        db.query("DELETE FROM message WHERE id=$id").run({ $id: mid });
        touchSession(db, sid);
        return { marker: mid, summaries: summaryKids.map((k) => k.id) };
      });
      return json({ data: removed, backup });
    }

    // V2 epoch
    sm = p.match(/^\/api\/sessions\/([^/]+)\/epoch$/);
    if (sm && m === "PUT") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      const baseline = String(b.baseline ?? "");
      if (!baseline) throw new Error("baseline text required");
      if (b.snapshot !== undefined) JSON.parse(String(typeof b.snapshot === "string" ? b.snapshot : JSON.stringify(b.snapshot)));
      const backup = ensureBackup();
      writeTxn(db, () => {
        const seq = Number(b.baseline_seq ?? 0);
        db.query("INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ($sid,$b,$s,$q) ON CONFLICT(session_id) DO UPDATE SET baseline=$b, snapshot=$s, baseline_seq=$q")
          .run({ $sid: sid, $b: baseline, $s: typeof b.snapshot === "string" ? b.snapshot : JSON.stringify(b.snapshot ?? {}), $q: seq });
      });
      return json({ data: getEpoch(db, sid), backup });
    }
    if (sm && m === "DELETE") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      const backup = ensureBackup();
      writeTxn(db, () => db.query("DELETE FROM session_context_epoch WHERE session_id=$sid").run({ $sid: sid }));
      return json({ data: { cleared: sid }, backup, note: "Next run will initialize a fresh baseline." });
    }

    // todos replace
    sm = p.match(/^\/api\/sessions\/([^/]+)\/todos$/);
    if (sm && m === "PUT") {
      const sid = decodeURIComponent(sm[1]!);
      mustSession(sid);
      if (!Array.isArray(b.todos)) throw new Error("todos must be an array");
      const backup = ensureBackup();
      const now = nowMs();
      writeTxn(db, () => {
        db.query("DELETE FROM todo WHERE session_id=$sid").run({ $sid: sid });
        (b.todos as Array<Record<string, unknown>>).forEach((t, i) => {
          db.query("INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES ($s,$c,$st,$p,$i,$n,$n)")
            .run({ $s: sid, $c: String(t.content ?? ""), $st: String(t.status ?? "pending"), $p: String(t.priority ?? "medium"), $i: i, $n: now });
        });
        touchSession(db, sid, now);
      });
      return json({ data: listTodos(db, sid), backup });
    }

    // restore
    if (p === "/api/backups/restore" && m === "POST") {
      const file = String(b.file ?? "");
      if (!file || file.includes("/") || file.includes("\\")) throw new Error("file must be a backup basename");
      const src = path.join(backupDir(), file);
      if (!fs.existsSync(src)) throw Object.assign(new Error("Backup not found"), { status: 404 });
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
      db.close();
      fs.copyFileSync(src, DB_PATH);
      db = openDb(DB_PATH);
      lastBackupAt = 0;
      return json({ data: { restored: file } });
    }

    return err("Not found", 404);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const status = (e as { status?: number }).status ?? (msg.includes("SQLITE_BUSY") || msg.includes("locked") ? 503 : 400);
    return err(msg, status);
  }
}

function serveStatic(p: string): Response {
  let rel = p === "/" ? "index.html" : p.slice(1);
  if (rel.includes("..")) return err("Not found", 404);
  let file = path.join(PUBLIC, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (!rel.startsWith("api/")) file = path.join(PUBLIC, "index.html");
    else return err("Not found", 404);
  }
  const ext = path.extname(file);
  const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".json" ? "application/json" : "application/octet-stream";
  return new Response(Bun.file(file), { headers: { "content-type": type } });
}

console.log(`opencode-editor on http://localhost:${PORT} (db: ${DB_PATH})`);
