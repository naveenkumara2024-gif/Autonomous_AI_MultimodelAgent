import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig } from "../config/config-store";
import type { MessageRow, SessionRow } from "../db/database";

export type SessionStatus = "created" | "idle" | "running" | "stopped" | "deleted";
export type MessageRole = "user" | "assistant" | "system";
/**
 * 'auto' until renameSession() is called; once 'manual', no automatic
 * process (title-generator.ts) may overwrite the title again. See
 * prompts/ai-title-generation.md.
 */
export type TitleSource = "auto" | "manual";

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  titleSource: TitleSource;
  status: SessionStatus;
  model: string;
  permissionHooks: AgentConfig["defaultPermissionHooks"];
  retryPolicy: AgentConfig["defaultRetryPolicy"];
  contextCompaction: AgentConfig["defaultContextCompaction"];
  createdAt: number;
  updatedAt: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source as TitleSource,
    status: row.status as SessionStatus,
    model: row.model,
    permissionHooks: JSON.parse(row.permission_hooks),
    retryPolicy: JSON.parse(row.retry_policy),
    contextCompaction: JSON.parse(row.context_compaction),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
  };
}

export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  createSession(title: string, config: AgentConfig): Session {
    const now = Date.now();
    const row: SessionRow = {
      id: randomUUID(),
      title,
      status: "created",
      model: config.defaultModel,
      permission_hooks: JSON.stringify(config.defaultPermissionHooks),
      retry_policy: JSON.stringify(config.defaultRetryPolicy),
      context_compaction: JSON.stringify(config.defaultContextCompaction),
      title_source: "auto",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions
          (id, title, status, model, permission_hooks, retry_policy, context_compaction, title_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.status,
        row.model,
        row.permission_hooks,
        row.retry_policy,
        row.context_compaction,
        row.title_source,
        row.created_at,
        row.updated_at,
      );

    return toSession(row);
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as unknown as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  updateTitle(id: string, title: string, source: TitleSource = "auto"): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE id = ?`)
      .run(title, source, Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  /** One-time model migration (e.g. Stage 1's unused placeholder → the real agent model). */
  replaceModel(from: string, to: string): number {
    return Number(this.db.prepare(`UPDATE sessions SET model = ? WHERE model = ?`).run(to, from).changes);
  }

  /** A turn can't survive an app restart; sessions left "running" by a crash go back to idle. */
  resetInterruptedRuns(): number {
    return Number(this.db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run().changes);
  }

  appendMessage(sessionId: string, role: MessageRole, content: string): Message {
    const row: MessageRow = {
      id: randomUUID(),
      session_id: sessionId,
      role,
      content,
      created_at: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.session_id, row.role, row.content, row.created_at);

    return toMessage(row);
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }
}
