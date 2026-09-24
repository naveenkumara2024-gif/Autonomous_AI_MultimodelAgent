import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ToolExecutionRow, TraceEventRow } from "../db/database";

/**
 * Claude Code-style activity trace: every step of every turn is recorded — model requests and
 * responses, the supervisor's checklist and routing, each tool call's risk verdict, approval,
 * lock wait, duration and result — to three sinks:
 *   1. SQLite (trace_events) so a session's full history survives a restart,
 *   2. the renderer (IPC "trace.event") for the live TracePanel,
 *   3. the main-process console, one line per event.
 * Event names follow AGENTS.md section 7's IPC vocabulary where one exists.
 */

export type TraceEventType =
  | "agent_start"
  | "agent_end"
  | "supervisor_decision"
  | "subagent_start"
  | "subagent_end"
  | "llm_request"
  | "llm_response"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_risk"
  | "approval_requested"
  | "approval_resolved"
  | "lock_wait"
  | "tool_execution_end"
  | "mcp_log"
  | "error";

export interface TraceEvent {
  id: string;
  sessionId: string;
  turnId: string;
  parentId: string | null;
  seq: number;
  ts: number;
  type: TraceEventType;
  /** "supervisor", a subagent name, or "system". */
  actor: string;
  data: Record<string, unknown>;
}

export interface TraceImageRef {
  path: string;
  mimeType: string;
}

type Send = (channel: string, payload: unknown) => void;

function toEvent(row: TraceEventRow): TraceEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    parentId: row.parent_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type as TraceEventType,
    actor: row.actor,
    data: JSON.parse(row.data),
  };
}

function consoleLine(e: TraceEvent): string {
  const d = e.data;
  const bits: string[] = [];
  if (typeof d.tool === "string") bits.push(d.tool);
  if (typeof d.intent === "string" && d.intent) bits.push(`"${d.intent}"`);
  if (typeof d.ms === "number") bits.push(`${d.ms}ms`);
  if (typeof d.status === "string") bits.push(d.status);
  if (typeof d.verdict === "string") bits.push(d.verdict);
  if (typeof d.outcome === "string") bits.push(d.outcome);
  if (typeof d.model === "string" && e.type.startsWith("llm_")) bits.push(d.model);
  if (typeof d.message === "string") bits.push(d.message.slice(0, 160));
  return `[trace ${e.sessionId.slice(0, 8)}] ${e.actor} ${e.type}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
}

export class TraceStore {
  private seq: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly imagesRoot: string,
    private readonly send: Send,
  ) {
    const row = db.prepare(`SELECT MAX(seq) AS max FROM trace_events`).get() as { max: number | null } | undefined;
    this.seq = row?.max ?? 0;
  }

  forTurn(sessionId: string, turnId: string): TurnTrace {
    return new TurnTrace(this, sessionId, turnId);
  }

  record(event: Omit<TraceEvent, "id" | "seq" | "ts">): TraceEvent {
    const full: TraceEvent = { ...event, id: randomUUID(), seq: ++this.seq, ts: Date.now() };
    this.db
      .prepare(`INSERT INTO trace_events (id, session_id, turn_id, parent_id, seq, ts, type, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(full.id, full.sessionId, full.turnId, full.parentId, full.seq, full.ts, full.type, full.actor, JSON.stringify(full.data));
    this.send("trace.event", full);
    console.log(consoleLine(full));
    return full;
  }

  list(sessionId: string): TraceEvent[] {
    const rows = this.db.prepare(`SELECT * FROM trace_events WHERE session_id = ? ORDER BY seq ASC`).all(sessionId) as unknown as TraceEventRow[];
    return rows.map(toEvent);
  }

  /**
   * Persists an image that ALREADY passed perception/redactor.ts (AGENTS.md section 7's memory
   * record carries only a redactedScreenshotRef — raw captures are never written anywhere).
   */
  saveImage(sessionId: string, base64: string, mimeType: string): TraceImageRef {
    const dir = path.join(this.imagesRoot, sessionId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.${mimeType === "image/png" ? "png" : "img"}`);
    writeFileSync(file, Buffer.from(base64, "base64"));
    return { path: file, mimeType };
  }

  /** Reads a trace image for the renderer; refuses any path outside the trace image folder. */
  readImage(filePath: string): string | null {
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.imagesRoot) + path.sep;
    if (!resolved.startsWith(root)) return null;
    try {
      return `data:image/png;base64,${readFileSync(resolved).toString("base64")}`;
    } catch {
      return null;
    }
  }

  recordToolExecution(row: ToolExecutionRow): void {
    this.db
      .prepare(
        `INSERT INTO tool_executions
          (id, session_id, tool, action, args, resources, outcome, created_at, turn_id, subagent, intent, risk_category, approval, duration_ms, is_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.session_id, row.tool, row.action, row.args, row.resources, row.outcome, row.created_at,
        row.turn_id, row.subagent, row.intent, row.risk_category, row.approval, row.duration_ms, row.is_error,
      );
  }

  /** Trace rows cascade with the session row; this removes the image files alongside them. */
  deleteSessionImages(sessionId: string): void {
    rmSync(path.join(this.imagesRoot, sessionId), { recursive: true, force: true });
  }
}

/** A trace scoped to one turn — what the agent code actually holds. */
export class TurnTrace {
  constructor(
    private readonly store: TraceStore,
    readonly sessionId: string,
    readonly turnId: string,
  ) {}

  emit(type: TraceEventType, actor: string, data: Record<string, unknown> = {}, parentId: string | null = null): string {
    return this.store.record({ sessionId: this.sessionId, turnId: this.turnId, parentId, type, actor, data }).id;
  }

  saveImage(base64: string, mimeType: string): TraceImageRef {
    return this.store.saveImage(this.sessionId, base64, mimeType);
  }

  recordToolExecution(row: Omit<ToolExecutionRow, "session_id" | "turn_id">): void {
    this.store.recordToolExecution({ ...row, session_id: this.sessionId, turn_id: this.turnId });
  }
}
