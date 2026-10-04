import { randomUUID } from "node:crypto";
import type { TurnTrace } from "../agent/trace";
import type { McpClientManager } from "../mcp/mcp-client";
import { adaptResult, splitIntent } from "../mcp/tool-adapter";
import { type CandidateImage, filterImagesForModel } from "../perception/redactor";
import type { ApprovalGate } from "../sandbox/approval-gate";
import { type ClassifierContext, classify, type ObservedDomElement, type ObservedElement } from "../sandbox/risk-classifier";
import type { ResourceLockManager } from "../sandbox/resource-lock-manager";
import { resolveResources } from "./resource-resolvers";

/**
 * The single dispatch path for every tool call, from every subagent (AGENTS.md section 11):
 *
 *   resolve `resources` from args → observe OS/DOM context → risk-classifier → (if flagged)
 *   approval-gate, blocking until the user decides → resource lock → MCP call → redactor on
 *   any images → persist (tool_executions + trace) → result back to the model.
 *
 * Subagents never talk to MCP directly; they hand calls here. A denied or failed call comes
 * back as a normal result the model can read and plan around — it is never silently retried.
 */

export interface ExecutorDeps {
  mcp: McpClientManager;
  approvals: ApprovalGate;
  locks: ResourceLockManager;
  policy: () => { allowScreenshotsToModel: boolean };
}

export interface TurnContext {
  sessionId: string;
  turnId: string;
  trace: TurnTrace;
  signal: AbortSignal;
}

export interface ToolCallRequest {
  tool: string;
  /** Model-supplied args, still including `intent`. */
  rawArgs: Record<string, unknown>;
  /** Assistant text that preceded the call (the section 7 `reasoningTrace`). Never classified. */
  reasoningTrace: string;
  subagent: string;
  parentTraceId: string | null;
}

export type ToolCallStatus = "ok" | "error" | "denied" | "cancelled";

export interface ToolCallOutcome {
  status: ToolCallStatus;
  /** What the model reads back. */
  text: string;
  /** Images that passed the redactor, ready to show the model. */
  images: CandidateImage[];
  traceId: string;
}

/** One executed call as the action cache sees it (memory/action-cache.ts builds recipes from these). */
export interface ExecutedCall {
  tool: string;
  /** Literal args, without `intent`. */
  args: Record<string, unknown>;
  intent: string;
  subagent: string;
  status: ToolCallStatus;
  isError: boolean;
  resources: string[];
  verdict: "allow" | "block-until-approved" | null;
  riskCategory: string | null;
  /** OS/DOM facts observed for classification (e.g. the focused field of a type_text). */
  context: ClassifierContext;
  /** Result text, truncated. */
  text: string;
}

const CONTEXT_LOOKUP_TIMEOUT_MS = 4000;
const LOCK_WAIT_TRACE_THRESHOLD_MS = 50;

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Per-tool MCP request timeout: long-running tools get their own budget plus headroom. */
function timeoutFor(tool: string, args: Record<string, unknown>): number {
  switch (tool) {
    case "run_powershell":
      return num(args.timeout_ms, 60_000) + 15_000;
    case "wait":
      return num(args.duration, 1000) + 5_000;
    case "browser_navigate":
      return num(args.timeout_ms, 30_000) + 10_000;
    case "find_element":
    case "browser_wait_for":
      return num(args.timeout_ms, 10_000) + 5_000;
    default:
      return 120_000;
  }
}

/**
 * The one-line `⎿` summary shown under a tool row. Computed here from the FULL result (the
 * stored preview is truncated), so structured results read as something meaningful — a
 * command's exit code and first output line, what an element lookup found — rather than "{".
 */
export function summarizeResult(text: string): string {
  const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return clip(firstLine(trimmed));

  let value: unknown;
  try {
    value = JSON.parse(trimmed.replace(/\n\[\d+ screenshot\(s\) withheld[\s\S]*$/, ""));
  } catch {
    return clip(firstLine(trimmed));
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const v = value as Record<string, unknown>;
  if ("exit_code" in v) {
    const out = String(v.stdout ?? "");
    const lines = out.split(/\r?\n/).filter((l) => l.trim());
    const head = v.timed_out ? "timed out" : v.cancelled ? "cancelled" : `exit ${v.exit_code}`;
    const body = lines.length ? ` — ${clip(lines[0]!.trim())}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}` : v.stderr ? ` — ${clip(firstLine(String(v.stderr)))}` : " — no output";
    return head + body;
  }
  if (typeof v.found === "boolean") {
    if (!v.found) return "not found";
    const what = [v.control_type, v.name ? `"${v.name}"` : null, v.tag, v.text ? `"${String(v.text).slice(0, 60)}"` : null].filter(Boolean).join(" ");
    return `found ${what}`.trim();
  }
  if (typeof v.url === "string") return clip(`${v.title ? `${v.title} — ` : ""}${v.url}`);
  // Tools that already phrase their outcome (launch_app) say it best themselves.
  if (typeof v.message === "string" && v.message) return clip(v.message);
  return clip(JSON.stringify(v));
}

/** Keeps giant args (a pasted document, a long script) readable in the trace. */
function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…(${v.length} chars)` : v]),
  );
}

export class ToolExecutor {
  /** Every call this turn, in completion order. */
  readonly log: ExecutedCall[] = [];

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly turn: TurnContext,
  ) {}

  /** Read-only lookup used only to observe context for classification; never classified itself. */
  private async lookup(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.deps.mcp.callTool(tool, args, { signal: this.turn.signal, timeoutMs: CONTEXT_LOOKUP_TIMEOUT_MS });
      const text = adaptResult(result).text;
      return result.isError ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  /**
   * Facts about what a call would actually touch, observed from the OS/DOM (not taken from the
   * model): the focused field for typing, the element under a click, the DOM target of a
   * browser click/type. If a lookup fails, classification proceeds on literal args alone and
   * the trace says so.
   */
  private async observeContext(tool: string, args: Record<string, unknown>): Promise<{ context: ClassifierContext; notes: string[] }> {
    const context: ClassifierContext = {};
    const notes: string[] = [];

    if (tool === "type_text") {
      const el = await this.lookup("find_element", { focused: true });
      if (el?.found) context.focusedElement = el as ObservedElement;
      else notes.push("focused element unavailable");
    } else if (tool === "click" && typeof args.x === "number" && typeof args.y === "number") {
      const el = await this.lookup("find_element", {
        at_point: { x: args.x, y: args.y, coordinate_type: args.coordinate_type ?? "auto", display_index: args.display_index ?? 0 },
      });
      if (el?.found) context.elementAtPoint = el as ObservedElement;
      else notes.push("element under click point unavailable");
    } else if ((tool === "browser_click" || tool === "browser_type") && typeof args.selector === "string") {
      const index = num(args.index, 0);
      const found = await this.lookup("browser_find", { selector: args.selector, all: index > 0 });
      const element = (index > 0 ? (found?.elements as ObservedDomElement[] | undefined)?.[index] : found?.element) as ObservedDomElement | undefined;
      if (element) context.domTarget = element;
      else notes.push("DOM target unavailable");
    }
    return { context, notes };
  }

  async execute(request: ToolCallRequest): Promise<ToolCallOutcome> {
    const { trace, signal } = this.turn;
    const { tool, subagent } = request;
    const { intent, args } = splitIntent(request.rawArgs);
    const resources = resolveResources(tool, args);
    const started = Date.now();

    const traceId = trace.emit("tool_execution_start", subagent, { tool, intent, args: truncateArgs(args), resources }, request.parentTraceId);
    let observed: ClassifierContext = {};
    let verdict: ExecutedCall["verdict"] = null;

    const finish = (status: ToolCallStatus, text: string, extra: Record<string, unknown>, images: CandidateImage[] = [], approval: string | null = null, category: string | null = null): ToolCallOutcome => {
      const ms = Date.now() - started;
      this.log.push({
        tool, args, intent, subagent, status, isError: extra.isError === true || status !== "ok",
        resources, verdict, riskCategory: category, context: observed, text: text.slice(0, 2000),
      });
      trace.emit("tool_execution_end", subagent, { tool, intent, status, ms, resultSummary: summarizeResult(text), resultPreview: text.slice(0, 600), ...extra }, traceId);
      trace.recordToolExecution({
        id: randomUUID(),
        tool,
        action: tool,
        args: JSON.stringify(truncateArgs(args)),
        resources: JSON.stringify(resources),
        outcome: JSON.stringify({ status, text: text.slice(0, 2000) }),
        created_at: started,
        subagent,
        intent,
        risk_category: category,
        approval,
        duration_ms: ms,
        is_error: status === "ok" ? 0 : 1,
      });
      return { status, text, images, traceId };
    };

    if (signal.aborted) return finish("cancelled", "Cancelled before running: the user stopped this turn.", {});

    // 1. Classify — on literal args plus OS/DOM observations, never on intent or reasoning.
    const { context, notes } = await this.observeContext(tool, args);
    const risk = classify(tool, args, context);
    observed = context;
    verdict = risk.verdict;
    trace.emit(
      "tool_risk",
      subagent,
      { tool, verdict: risk.verdict, category: risk.category, categories: risk.categories, reasons: risk.reasons, matchedRules: risk.matchedRules, context, notes },
      traceId,
    );

    // 2. Approval gate — blocks until the user decides.
    let approval: string | null = null;
    if (risk.verdict === "block-until-approved") {
      trace.emit("approval_requested", subagent, { tool, intent, category: risk.category, reasons: risk.reasons }, traceId);
      const outcome = await this.deps.approvals.request(
        { sessionId: this.turn.sessionId, turnId: this.turn.turnId, subagent, tool, intent, args: truncateArgs(args), risk },
        signal,
      );
      approval = outcome;
      trace.emit("approval_resolved", subagent, { tool, outcome }, traceId);
      if (outcome !== "approved") {
        const why = outcome === "denied" ? "The user DENIED this action" : outcome === "timeout" ? "No approval was given in time" : "The turn was cancelled";
        return finish(
          outcome === "cancelled" ? "cancelled" : "denied",
          `${why}; it was NOT executed (${risk.reasons.join("; ")}). Do not retry the same action. Choose a different approach that doesn't need it, or report back that it's blocked.`,
          { approval: outcome },
          [],
          approval,
          risk.category,
        );
      }
    }

    // 3. Resource lock — serializes only against calls that touch the same resources.
    let lease;
    try {
      lease = await this.deps.locks.acquire(resources, signal);
    } catch {
      return finish("cancelled", "Cancelled while waiting for a resource: the user stopped this turn.", {}, [], approval, risk.category);
    }
    if (lease.waitedMs >= LOCK_WAIT_TRACE_THRESHOLD_MS) trace.emit("lock_wait", subagent, { tool, resources, ms: lease.waitedMs }, traceId);

    // 4. Execute.
    let adapted;
    try {
      adapted = adaptResult(await this.deps.mcp.callTool(tool, args, { signal, timeoutMs: timeoutFor(tool, args) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) return finish("cancelled", "Cancelled: the user stopped this turn.", {}, [], approval, risk.category);
      return finish("error", `Tool call failed: ${message}`, { error: message }, [], approval, risk.category);
    } finally {
      lease.release();
    }

    // 5. Screen-content firewall on anything headed to the model.
    const firewall = filterImagesForModel(adapted.images, this.deps.policy());
    const imageRefs = firewall.allowed.map((img) => trace.saveImage(img.data, img.mimeType));
    let text = adapted.text || (adapted.isError ? "The tool reported an error with no details." : "Done.");
    if (firewall.withheld.length > 0) {
      text += `\n[${firewall.withheld.length} screenshot(s) withheld: ${firewall.withheld.map((w) => w.reason).join("; ")}. Rely on find_element / DOM tools instead.]`;
    }

    return finish(
      adapted.isError ? "error" : "ok",
      text,
      { isError: adapted.isError, images: imageRefs, imagesWithheld: firewall.withheld.length, redactionNotes: firewall.notes },
      firewall.allowed,
      approval,
      risk.category,
    );
  }
}
