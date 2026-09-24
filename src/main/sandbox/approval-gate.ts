import { randomUUID } from "node:crypto";
import type { RiskAssessment } from "./risk-classifier";

/**
 * Blocks a flagged tool call until the user explicitly approves it (AGENTS.md sections 3, 11).
 * The dialog lives in the renderer (ApprovalDialog.tsx); this side owns the pending table and
 * the timeout. Anything other than an explicit Approve — Deny, timeout, the turn being
 * cancelled, the window closing — resolves as NOT approved. There is no path by which the
 * agent can approve its own request.
 */

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export type ApprovalOutcome = "approved" | "denied" | "timeout" | "cancelled";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  subagent: string;
  tool: string;
  intent: string;
  args: Record<string, unknown>;
  risk: RiskAssessment;
  requestedAt: number;
  expiresAt: number;
}

type Send = (channel: string, payload: unknown) => void;

interface Pending {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
}

export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly send: Send) {}

  request(input: Omit<ApprovalRequest, "id" | "requestedAt" | "expiresAt">, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const now = Date.now();
    const request: ApprovalRequest = { ...input, id: randomUUID(), requestedAt: now, expiresAt: now + APPROVAL_TIMEOUT_MS };
    if (signal?.aborted) return Promise.resolve("cancelled");

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), APPROVAL_TIMEOUT_MS);
      const onAbort = () => settle("cancelled");
      const settle = (outcome: ApprovalOutcome) => {
        if (!this.pending.has(request.id)) return;
        this.pending.delete(request.id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.send("approval.resolved", { id: request.id, sessionId: request.sessionId, outcome });
        resolve(outcome);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, { request, settle });
      this.send("approval.request", request);
    });
  }

  /** The renderer's answer. Unknown/expired ids are ignored (the call already resolved). */
  respond(id: string, approved: boolean): void {
    this.pending.get(id)?.settle(approved ? "approved" : "denied");
  }

  /** Still-open requests, so a reloaded renderer can re-show its dialog. */
  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** Deny everything outstanding (app shutting down). */
  denyAll(): void {
    for (const p of [...this.pending.values()]) p.settle("cancelled");
  }
}
