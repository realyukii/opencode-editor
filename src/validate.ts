// Minimal validators for write payloads. The `data` JSON columns keep their
// full opencode shape; we only guard the fields the editor is allowed to
// touch so a bad edit cannot corrupt the runner.

export function assertRecord(v: unknown, what: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be a JSON object`);
}

const PART_TYPES = new Set([
  "text", "reasoning", "tool", "file", "compaction", "subtask",
  "step-start", "step-finish", "patch", "agent",
]);

export function validatePartData(data: Record<string, unknown>): void {
  const t = data.type;
  if (typeof t !== "string" || !PART_TYPES.has(t)) throw new Error(`part.data.type must be one of ${[...PART_TYPES].join(",")}`);
  if (t === "text" && typeof data.text !== "string") throw new Error("text part requires string .text");
  if (t === "tool") {
    const s = data.state as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") throw new Error("tool part requires .state object");
    if (!["pending", "running", "completed", "error"].includes(String(s.status)))
      throw new Error("tool part .state.status invalid");
  }
  if (t === "compaction" && data.tail_start_id !== undefined && typeof data.tail_start_id !== "string")
    throw new Error("compaction part .tail_start_id must be a string message id");
}

export function validateMessageData(data: Record<string, unknown>): void {
  if (!["user", "assistant"].includes(String(data.role))) throw new Error("message.data.role must be user|assistant");
}

const SESSION_FIELDS = new Set(["title", "cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "agent", "time_archived"]);
export function validateSessionPatch(patch: Record<string, unknown>): void {
  for (const k of Object.keys(patch)) {
    if (!SESSION_FIELDS.has(k)) throw new Error(`session field not editable: ${k}`);
  }
  if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim()))
    throw new Error("title must be a non-empty string");
  for (const n of ["cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"]) {
    if (patch[n] !== undefined && typeof patch[n] !== "number") throw new Error(`${n} must be a number`);
  }
}
