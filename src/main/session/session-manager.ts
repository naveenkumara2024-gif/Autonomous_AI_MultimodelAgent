import type { DatabaseSync } from "node:sqlite";
import { AgentRunner, type AgentRunnerDeps } from "../agent/agent-runner";
import { generateTitle, TITLE_MAX_LENGTH } from "../agent/title-generator";
import type { TraceEvent } from "../agent/trace";
import { type AgentConfig, LEGACY_PLACEHOLDER_MODEL } from "../config/config-store";
import type { Message, Session, SessionStatus } from "./session-store";
import { SessionStore } from "./session-store";

export type SendToRenderer = (channel: string, payload: unknown) => void;

export class SessionManager {
  private readonly store: SessionStore;
  /** Warm AgentRunners (compiled supervisor graph), one per started session — section 6. */
  private readonly runners = new Map<string, AgentRunner>();

  constructor(
    db: DatabaseSync,
    private readonly config: AgentConfig,
    private readonly sendToRenderer: SendToRenderer,
    private readonly agent: AgentRunnerDeps,
  ) {
    this.store = new SessionStore(db);
    const migrated = this.store.replaceModel(LEGACY_PLACEHOLDER_MODEL, config.defaultModel);
    if (migrated) console.log(`[session] moved ${migrated} session(s) from the unused "${LEGACY_PLACEHOLDER_MODEL}" placeholder to ${config.defaultModel}`);
    const interrupted = this.store.resetInterruptedRuns();
    if (interrupted) console.log(`[session] ${interrupted} session(s) were mid-turn when the app last closed; reset to idle`);
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  listMessages(sessionId: string): Message[] {
    return this.store.listMessages(sessionId);
  }

  listTrace(sessionId: string): TraceEvent[] {
    return this.agent.traces.list(sessionId);
  }

  createSession(title?: string): Session {
    const session = this.store.createSession(title?.trim() || "New session", this.config);
    this.sendToRenderer("session.update", session);
    return session;
  }

  /**
   * Boots this session's AgentRunner (compiles its supervisor graph) and leaves it warm in
   * `idle` (section 6) — once per session, not per prompt. The MCP automation server is shared
   * app-wide and started lazily on first use. The WSL2 VM sandbox is intentionally not part of
   * this stage (host execution behind the approval gate — stage-3 prompt decision 6).
   */
  startSession(sessionId: string): Session {
    this.requireSession(sessionId);
    if (!this.runners.has(sessionId)) this.runners.set(sessionId, new AgentRunner(sessionId, this.agent));
    this.store.updateStatus(sessionId, "idle");
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.status", { id: sessionId, status: updated.status });
    return updated;
  }

  /**
   * Appends the user's message and starts a turn in the background; returns immediately with
   * the session `running`. The turn streams trace events as it works, then appends the
   * assistant's reply and returns the session to `idle` (section 7's event sequence).
   */
  continueSession(sessionId: string, content: string): { session: Session; message: Message } {
    let session = this.requireSession(sessionId);
    if (session.status === "running" || this.runners.get(sessionId)?.isRunning) {
      throw new Error("This session is still working on the previous request. Wait for it to finish or stop it first.");
    }
    if (session.status === "created" || session.status === "stopped" || !this.runners.has(sessionId)) {
      session = this.startSession(sessionId);
    }

    const history = this.store
      .listMessages(sessionId)
      .filter((m): m is Message & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const message = this.store.appendMessage(sessionId, "user", content);
    this.store.updateStatus(sessionId, "running");
    this.sendToRenderer("session.status", { id: sessionId, status: "running" });

    // First message on a not-yet-titled, not-manually-renamed session: set
    // an instant truncated title so something reasonable shows right away,
    // then refine it with the AI title-generator in the background (never
    // awaited here — a hung/slow network call must not add latency to
    // sending a message). See prompts/ai-title-generation.md.
    if (session.title === "New session" && session.titleSource === "auto") {
      const truncated = content.length > TITLE_MAX_LENGTH ? `${content.slice(0, TITLE_MAX_LENGTH)}…` : content;
      this.store.updateTitle(sessionId, truncated, "auto");
      void this.refineTitleWithAI(sessionId, content);
    }

    void this.runTurn(sessionId, message, history, session);

    const current = this.requireSession(sessionId);
    this.sendToRenderer("session.update", current);
    return { session: current, message };
  }

  private async runTurn(sessionId: string, message: Message, history: Array<{ role: "user" | "assistant"; content: string }>, session: Session): Promise<void> {
    const runner = this.runners.get(sessionId)!;
    const outcome = await runner.run({
      turnId: message.id,
      userText: message.content,
      history,
      model: session.model,
      retryPolicy: session.retryPolicy,
    });

    // The session may have been deleted mid-turn.
    if (!this.store.getSession(sessionId)) return;
    const reply = this.store.appendMessage(sessionId, "assistant", outcome.text);
    this.sendToRenderer("session.message", reply);
    this.store.updateStatus(sessionId, "idle");
    this.sendToRenderer("session.status", { id: sessionId, status: "idle" });
    this.sendToRenderer("session.update", this.requireSession(sessionId));
  }

  /** Stops the in-flight turn, if any. The session stays warm (idle) for the next prompt. */
  cancelTurn(sessionId: string): void {
    this.runners.get(sessionId)?.cancel();
  }

  renameSession(sessionId: string, title: string): Session {
    this.requireSession(sessionId);
    const trimmed = title.trim();
    if (trimmed) {
      // A human rename always wins — 'manual' blocks any in-flight or future
      // refineTitleWithAI() result from overwriting it.
      this.store.updateTitle(sessionId, trimmed, "manual");
    }
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.update", updated);
    return updated;
  }

  /**
   * Fire-and-forget: calls the AI title-generator and applies the result
   * only if the session is still 'auto' by the time the call resolves —
   * re-checked from the store (not the caller's stale `session` object) to
   * close the race against a manual rename happening while this is in
   * flight. Never throws; a failed/slow call just leaves the truncated
   * fallback title in place.
   */
  private async refineTitleWithAI(sessionId: string, firstMessage: string): Promise<void> {
    const aiTitle = await generateTitle(firstMessage);
    if (!aiTitle) return;

    const current = this.store.getSession(sessionId);
    if (!current || current.titleSource !== "auto") return;

    this.store.updateTitle(sessionId, aiTitle, "auto");
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.update", updated);
  }

  /** Tears down this session's runner (cancelling any turn). History stays in SQLite. */
  stopSession(sessionId: string): Session {
    this.requireSession(sessionId);
    this.runners.get(sessionId)?.cancel();
    this.runners.delete(sessionId);
    this.store.updateStatus(sessionId, "stopped");
    const updated = this.requireSession(sessionId);
    this.sendToRenderer("session.status", { id: sessionId, status: updated.status });
    return updated;
  }

  deleteSession(sessionId: string): void {
    this.requireSession(sessionId);
    this.runners.get(sessionId)?.cancel();
    this.runners.delete(sessionId);
    this.store.deleteSession(sessionId);
    this.agent.traces.deleteSessionImages(sessionId);
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
