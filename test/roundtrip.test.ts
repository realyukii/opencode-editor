import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { listMessages, listSessions, writeTxn, newId } from "../src/db";
import { filterCompacted, suggestTailStart, estimateTokens } from "../src/history";
import { validatePartData, validateMessageData, validateSessionPatch } from "../src/validate";

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.query("INSERT INTO project (id, worktree, time_created) VALUES ('p1','/tmp',1)").run();
  db.query("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_test','p1','s','/tmp','t','1',$n,$n)".replaceAll("$n", "1000")).run();
  return db;
}
function addMsg(db: Database, sid: string, role: string, parts: unknown[], t: number, extra: Record<string, unknown> = {}) {
  const mid = newId("msg");
  db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($id,$sid,$t,$t,$d)")
    .run({ $id: mid, $sid: sid, $t: t, $d: JSON.stringify({ role, ...extra }) });
  for (const p of parts) {
    db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id,$mid,$sid,$t,$t,$d)")
      .run({ $id: newId("prt"), $mid: mid, $sid: sid, $t: t, $d: JSON.stringify(p) });
  }
  return mid;
}

let db: Database;
beforeEach(() => { db = fixture(); });

describe("db helpers", () => {
  test("listSessions / listMessages hydrate", () => {
    addMsg(db, "ses_test", "user", [{ type: "text", text: "hi" }], 1001);
    expect(listSessions(db).length).toBe(1);
    const msgs = listMessages(db, "ses_test");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.parts.length).toBe(1);
  });
  test("writeTxn rolls back on throw", () => {
    expect(() => writeTxn(db, () => {
      addMsg(db, "ses_test", "user", [{ type: "text", text: "x" }], 1002);
      throw new Error("boom");
    })).toThrow("boom");
    expect(listMessages(db, "ses_test").length).toBe(0);
  });
  test("newId shape", () => {
    expect(newId("msg")).toMatch(/^msg_[A-Za-z0-9]{26}$/);
    expect(newId("ses")).not.toBe(newId("ses"));
  });
});

describe("filterCompacted", () => {
  test("no compaction → everything visible", () => {
    addMsg(db, "ses_test", "user", [{ type: "text", text: "a" }], 1001);
    addMsg(db, "ses_test", "assistant", [{ type: "text", text: "b" }], 1002);
    const p = filterCompacted(listMessages(db, "ses_test"));
    expect(p.projected.length).toBe(2);
    expect(p.hiddenCount).toBe(0);
  });
  test("completed compaction hides head, keeps tail", () => {
    const m1 = addMsg(db, "ses_test", "user", [{ type: "text", text: "old" }], 1001);
    addMsg(db, "ses_test", "assistant", [{ type: "text", text: "old answer" }], 1002);
    const m3 = addMsg(db, "ses_test", "user", [{ type: "text", text: "keep me" }], 1003);
    addMsg(db, "ses_test", "assistant", [{ type: "text", text: "kept" }], 1004);
    const marker = addMsg(db, "ses_test", "user", [{ type: "compaction", tail_start_id: m3 }], 1005);
    addMsg(db, "ses_test", "assistant", [{ type: "text", text: "summary" }], 1006, { summary: true, finish: "stop", parentID: marker });
    void m1;
    const p = filterCompacted(listMessages(db, "ses_test"));
    expect(p.tailStartId).toBe(m3);
    expect(p.hiddenCount).toBe(2); // m1 + its answer replaced by summary
    expect(p.projected[0]!.info.id).toBe(marker); // summary pair first
    expect(p.projected.map((m) => m.info.id)).toContain(m3);
  });
  test("suggestTailStart respects budget", () => {
    for (let i = 0; i < 6; i++) {
      addMsg(db, "ses_test", "user", [{ type: "text", text: "q" + i + "x".repeat(500) }], 1001 + i * 2);
      addMsg(db, "ses_test", "assistant", [{ type: "text", text: "a" + i }], 1002 + i * 2);
    }
    const { tail_start_id, keptTokens } = suggestTailStart(listMessages(db, "ses_test"), 500);
    expect(tail_start_id).toBeString();
    expect(keptTokens).toBeLessThanOrEqual(500);
    expect(estimateTokens({ a: 1 })).toBeGreaterThan(0);
  });
});

describe("validators", () => {
  test("part types enforced", () => {
    expect(() => validatePartData({ type: "nope" })).toThrow();
    expect(() => validatePartData({ type: "text" })).toThrow(); // missing .text
    validatePartData({ type: "text", text: "ok" });
    expect(() => validatePartData({ type: "tool", state: { status: "weird" } })).toThrow();
  });
  test("message role enforced", () => {
    expect(() => validateMessageData({ role: "system" })).toThrow();
    validateMessageData({ role: "user" });
  });
  test("session patch allowlist", () => {
    expect(() => validateSessionPatch({ directory: "/x" })).toThrow();
    expect(() => validateSessionPatch({ title: " " })).toThrow();
    validateSessionPatch({ title: "new", tokens_input: 5 });
  });
});
