import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig } from "../config/config-store";
import type { Message, Session, SessionStatus } from "./session-store";
import { SessionStore } from "./session-store";

export type SendToRenderer = (channel: string, payload: unknown) => void;

const TITLE_MAX_LENGTH = 60;

export class SessionManager {
  private readonly store: SessionStore;

  constructor(
    db: DatabaseSync,
    private readonly config: AgentConfig,
    private readonly sendToRenderer: SendToRenderer,
  ) {
    this.store = new SessionStore(db);
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  listMessages(sessionId: string): Message[] {
    return this.store.listMessages(sessionId);
  }

  createSession(title?: string): Session {
    const session = this.store.createSession(title?.trim() || "New session", this.config);
    this.sendToRenderer("session.update", session);
    return session;
  }

  /**
   * Boots AgentRunner + Sandbox for this session (section 6). Neither exists
   * yet (Stage 2 / Stage 4) — this transitions created/stopped -> idle and
   * logs that the real boot is deferred, rather than pretending it happened.
   */
  startSession(sessionId: string): Session {
    const session = this.requireSession(sessionId);
    console.log(`[session] start stub for ${sessionId} — agent/sandbox boot stub, real boot arrives in Stage 2/4`);
    this.store.updateStatus(sessionId, "idle");
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.status", { id: sessionId, status: updated.status });
    return updated;
  }

  /**
   * Stage 1: appends the user's message and returns to idle. No agent exists
   * yet to produce a reply — message_update, tool_execution_start/end, and
   * agent_end are intentionally not emitted here; they belong to the real
   * supervisor loop.
   */
  continueSession(sessionId: string, content: string): { session: Session; message: Message } {
    let session = this.requireSession(sessionId);

    if (session.status === "created" || session.status === "stopped") {
      session = this.startSession(sessionId);
    }

    this.store.updateStatus(sessionId, "running");
    this.sendToRenderer("session.status", { id: sessionId, status: "running" });

    const message = this.store.appendMessage(sessionId, "user", content);

    if (session.title === "New session") {
      const title = content.length > TITLE_MAX_LENGTH ? `${content.slice(0, TITLE_MAX_LENGTH)}…` : content;
      this.store.updateTitle(sessionId, title);
    }

    this.store.updateStatus(sessionId, "idle");
    const finalSession = this.requireSession(sessionId);
    this.sendToRenderer("session.status", { id: sessionId, status: "idle" });
    this.sendToRenderer("session.update", finalSession);

    return { session: finalSession, message };
  }

  renameSession(sessionId: string, title: string): Session {
    this.requireSession(sessionId);
    const trimmed = title.trim();
    if (trimmed) {
      this.store.updateTitle(sessionId, trimmed);
    }
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.update", updated);
    return updated;
  }

  stopSession(sessionId: string): Session {
    this.requireSession(sessionId);
    console.log(`[session] stop stub for ${sessionId} — agent/sandbox teardown stub, real teardown arrives in Stage 2/4`);
    this.store.updateStatus(sessionId, "stopped");
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.status", { id: sessionId, status: updated.status });
    return updated;
  }

  deleteSession(sessionId: string): void {
    this.requireSession(sessionId);
    this.store.deleteSession(sessionId);
    this.sendToRenderer("session.update", { id: sessionId, deleted: true });
  }

  private requireSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`session-manager: unknown session ${sessionId}`);
    }
    return session;
  }
}

export type { SessionStatus };
