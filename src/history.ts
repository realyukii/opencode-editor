import type { MessageWithParts } from "./db";

// ---------------------------------------------------------------------------
// Token estimate: opencode uses Token.estimate ≈ ceil(chars/4) on the
// JSON-serialized model request. We apply the same heuristic to the
// projected context so the preview tracks the real preflight check.
// ---------------------------------------------------------------------------
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

type Part = Record<string, unknown> & { type?: string };
type Msg = MessageWithParts;

function isCompactionUser(m: Msg): boolean {
  return m.info.role === "user" && m.parts.some((p) => (p as Part).type === "compaction");
}
function compactionPart(m: Msg): (Part & { tail_start_id?: string }) | undefined {
  return m.parts.find((p) => (p as Part).type === "compaction") as Part | undefined;
}
function isSummaryAssistant(m: Msg): boolean {
  const info = m.info as { summary?: boolean; finish?: string; error?: unknown };
  return m.info.role === "assistant" && info.summary === true && !!info.finish && !info.error;
}

export interface Projection {
  /** messages in the order the model sees them */
  projected: Msg[];
  /** full durable transcript length */
  totalMessages: number;
  compactionIndex: number; // -1 when no completed compaction
  summaryIndex: number;
  tailStartId: string | null;
  hiddenCount: number; // durable messages replaced by the summary
  estimatedTokens: number;
}

// Port of MessageV2.filterCompacted (packages/opencode/src/session/message-v2.ts).
// Durable history is never mutated here; we only reorder/select.
export function filterCompacted(msgs: Msg[]): Projection {
  const totalMessages = msgs.length;
  const result: Msg[] = [];
  const completed = new Set<string>(); // user msg ids with a finished summary
  let retain: string | undefined;

  // NOTE: opencode's MessageV2.stream() yields newest-first, so the scan
  // below walks newest → oldest (completed summaries are seen before
  // their markers). listMessages() returns oldest-first, hence reversed.
  for (const msg of [...msgs].reverse()) {
    result.push(msg);
    if (retain) {
      if (msg.info.id === retain) break;
      continue;
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = compactionPart(msg);
      if (!part) continue;
      if (!part.tail_start_id) break;
      retain = part.tail_start_id;
      if (msg.info.id === retain) break;
      continue;
    }
    if (msg.info.role === "assistant" && isSummaryAssistant(msg)) {
      completed.add(String((msg.info as { parentID?: string }).parentID ?? ""));
    }
  }
  result.reverse();

  const compactionIndex = result.findLastIndex(
    (m) => m.info.role === "user" && ((compactionPart(m)?.tail_start_id ?? undefined) !== undefined),
  );
  const compaction = compactionIndex >= 0 ? result[compactionIndex]! : undefined;
  const tailStartId = compaction ? String(compactionPart(compaction)!.tail_start_id) : null;
  const summaryIndex = compaction
    ? result.findIndex(
        (m, i) =>
          i > compactionIndex && m.info.role === "assistant" && isSummaryAssistant(m) &&
          String((m.info as { parentID?: string }).parentID) === compaction.info.id,
      )
    : -1;
  const tailIndex = tailStartId ? result.findIndex((m) => m.info.id === tailStartId) : -1;

  let projected: Msg[];
  // The scan breaks at the retained tail, so rows older than the tail never
  // entered `result` — those are exactly the messages the summary replaces.
  const hiddenCount = totalMessages - result.length;
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    projected = [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ];
  } else {
    projected = result;
  }
  return {
    projected,
    totalMessages,
    compactionIndex,
    summaryIndex,
    tailStartId,
    hiddenCount,
    estimatedTokens: estimateTokens(
      projected.map((m) => ({ role: m.info.role, parts: m.parts.map((p) => summarizePart(p)) })),
    ),
  };
}

// Lossy per-part summary mirroring compaction.ts serialize()/truncate().
export function summarizePart(p: Record<string, unknown>): unknown {
  const type = String(p.type ?? "unknown");
  if (type === "text") {
    const t = String((p as { text?: string }).text ?? "");
    return { type, text: t.length > 2000 ? t.slice(0, 2000) + "\n[truncated]" : t };
  }
  if (type === "tool") {
    const state = (p as { state?: { status?: string; output?: string } }).state;
    const out = String(state?.output ?? "");
    return {
      type, tool: (p as { tool?: string }).tool,
      status: state?.status,
      output: out.length > 2000 ? out.slice(0, 2000) + "\n[truncated]" : out,
    };
  }
  if (type === "file") return { type, mime: (p as { mime?: string }).mime, filename: (p as { filename?: string }).filename };
  if (type === "compaction") return { type, tail_start_id: (p as { tail_start_id?: string }).tail_start_id };
  if (type === "reasoning") return { type, text: String((p as { text?: string }).text ?? "").slice(0, 500) };
  return { type };
}

// ---------------------------------------------------------------------------
// Tail-turn estimator: given full history + a keep budget (tokens), suggest
// the message id where a new compaction's retained tail should start.
// Mirrors compaction.ts select(): walk user-turns from newest, keep while
// cumulative estimate fits the budget.
// ---------------------------------------------------------------------------
export function suggestTailStart(msgs: Msg[], budgetTokens = 15000): { tail_start_id: string | null; keptTokens: number } {
  const turns: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.info.role === "user" && !isCompactionUser(msgs[i]!)) turns.push(i);
  }
  let total = 0;
  let keep: string | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const start = turns[i]!;
    const end = i + 1 < turns.length ? turns[i + 1]! : msgs.length;
    const size = estimateTokens(msgs.slice(start, end).map((m) => ({ role: m.info.role, parts: m.parts.map(summarizePart) })));
    if (total + size <= budgetTokens) {
      total += size;
      keep = String(msgs[start]!.info.id);
      continue;
    }
    break;
  }
  return { tail_start_id: keep, keptTokens: total };
}
