import { Annotation, END, type LangGraphRunnableConfig, Send, START, StateGraph } from "@langchain/langgraph";
import type { McpClientManager } from "../mcp/mcp-client";
import { type FunctionTool, toFunctionTool } from "../mcp/tool-adapter";
import type { ApprovalGate } from "../sandbox/approval-gate";
import type { ResourceLockManager } from "../sandbox/resource-lock-manager";
import { ToolExecutor } from "../tools/tool-executor";
import { type ChatMessage, chat, parseToolArgs } from "./llm-client";
import type { EnvironmentFacts } from "./prompts/shared";
import { supervisorSystemPrompt, supervisorTools } from "./prompts/supervisor";
import { runSubagent, type SubagentResult } from "./subagent-loop";
import { listSubagents, type SubagentDef } from "./subagent-registry";
import { registerBuiltInSubagents } from "./subagents";
import type { TraceStore, TurnTrace } from "./trace";

/**
 * The per-session LangGraph.js supervisor (AGENTS.md section 10): one supervisor node, one
 * node per registered subagent, and edges that ALWAYS lead from a subagent back to the
 * supervisor — never subagent → subagent, because that would skip the retry cap and the
 * checklist. Independent checklist items fan out in parallel via `Send`; whether their tool
 * calls truly run simultaneously is decided per call by the resource lock manager.
 *
 * The graph is compiled once per session (kept warm while the session is idle — section 6);
 * each turn's dependencies (trace, executor, abort signal) arrive through `configurable`.
 */

export interface ChecklistItem {
  id: string;
  text: string;
  status: "pending" | "done" | "failed" | "blocked";
  failures: number;
  note?: string;
}

export interface Dispatch {
  id: string; // the supervisor's tool_call id — the subagent's report answers it
  subagent: string;
  brief: string;
  checklistItemIds: string[];
}

export type TurnStatus = "done" | "partial" | "failed" | "needs_user" | "cap_reached" | "cancelled" | "error";

export interface TurnOutcome {
  status: TurnStatus;
  text: string;
}

const TurnState = Annotation.Root({
  messages: Annotation<ChatMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  checklist: Annotation<ChecklistItem[]>({ reducer: (_, b) => b, default: () => [] }),
  pending: Annotation<Dispatch[]>({ reducer: (_, b) => b, default: () => [] }),
  results: Annotation<SubagentResult[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  applied: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  rounds: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  final: Annotation<TurnOutcome | null>({ reducer: (_, b) => b, default: () => null }),
});
type State = typeof TurnState.State;

/** Everything a turn needs, passed to nodes through `configurable.runtime`. */
interface TurnRuntime {
  model: string;
  facts: EnvironmentFacts;
  trace: TurnTrace;
  executor: ToolExecutor;
  signal: AbortSignal;
  maxRounds: number;
  maxRetries: number;
  subagentTools: Map<string, FunctionTool[]>;
}

function runtimeOf(config: LangGraphRunnableConfig): TurnRuntime {
  return (config.configurable as { runtime: TurnRuntime }).runtime;
}

const HISTORY_MESSAGES = 12;
const MAX_REPORT_CHARS = 8000;

function statusReport(checklist: ChecklistItem[], reason: string): string {
  const icon = { done: "✅", failed: "❌", blocked: "⛔", pending: "⏳" } as const;
  const lines = checklist.map((c) => `- ${icon[c.status]} ${c.text}${c.note ? ` — ${c.note}` : ""}`);
  return `${reason}\n\n${lines.length ? `**Status:**\n${lines.join("\n")}` : "No work items were completed."}`;
}

/** Folds subagent reports that arrived since the last round into the checklist. */
function applyResults(state: State): ChecklistItem[] {
  const checklist = state.checklist.map((c) => ({ ...c }));
  for (const result of state.results.slice(state.applied)) {
    for (const id of result.checklistItemIds) {
      const item = checklist.find((c) => c.id === id);
      if (!item) continue;
      if (result.status === "done") item.status = "done";
      else if (result.status === "blocked") item.status = "blocked";
      else if (result.status === "failed") {
        item.status = "failed";
        item.failures++;
      }
      item.note = result.summary.slice(0, 200);
    }
  }
  return checklist;
}

function buildGraph(subagents: SubagentDef[]) {
  const names = subagents.map((s) => s.name);

  const supervisor = async (state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> => {
    const rt = runtimeOf(config);
    const rounds = state.rounds + 1;
    let checklist = applyResults(state);
    const applied = state.results.length;

    if (rt.signal.aborted) return { final: { status: "cancelled", text: statusReport(checklist, "Stopped by the user.") }, checklist, applied, rounds };
    if (rounds > rt.maxRounds) {
      return { final: { status: "cap_reached", text: statusReport(checklist, `I stopped after ${rt.maxRounds} planning rounds without finishing.`) }, checklist, applied, rounds };
    }

    const team = subagents.map((s) => ({ name: s.name, description: s.description }));
    const system: ChatMessage = { role: "system", content: supervisorSystemPrompt(rt.facts, team, { maxDispatches: rt.maxRounds, maxRetries: rt.maxRetries }) };
    const checklistNote: ChatMessage[] = checklist.length
      ? [{ role: "user", content: `(Current checklist — for your reference)\n${checklist.map((c) => `- [${c.status}] ${c.id}: ${c.text}${c.failures ? ` (failed ${c.failures}×)` : ""}`).join("\n")}` }]
      : [];

    const response = await chat({
      model: rt.model,
      messages: [system, ...state.messages, ...checklistNote],
      tools: supervisorTools(names),
      toolChoice: "required",
      signal: rt.signal,
      trace: rt.trace,
      actor: "supervisor",
      purpose: `round ${rounds}`,
    });

    if (response.content) rt.trace.emit("message_update", "supervisor", { text: response.content });
    const assistant: ChatMessage = { role: "assistant", content: response.content || null, ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}) };
    const replies: ChatMessage[] = [];
    const pending: Dispatch[] = [];
    const rejected: string[] = [];
    let final: TurnOutcome | null = null;
    const reply = (id: string, content: string) => replies.push({ role: "tool", tool_call_id: id, content });

    for (const call of response.toolCalls) {
      const parsed = parseToolArgs(call);
      if (!parsed.ok) {
        reply(call.id, `Error: ${parsed.error}`);
        continue;
      }
      const a = parsed.args;
      switch (call.function.name) {
        case "set_checklist": {
          const items = Array.isArray(a.items) ? a.items : [];
          checklist = items
            .filter((i): i is { id: string; text: string } => typeof i?.id === "string" && typeof i?.text === "string")
            .map((i) => ({ id: i.id, text: i.text, status: "pending" as const, failures: 0 }));
          reply(call.id, `Checklist recorded (${checklist.length} items).`);
          break;
        }
        case "update_checklist": {
          for (const u of Array.isArray(a.updates) ? a.updates : []) {
            const item = checklist.find((c) => c.id === u?.id);
            if (item && ["pending", "done", "failed", "blocked"].includes(u.status)) {
              item.status = u.status;
              if (typeof u.note === "string") item.note = u.note;
            }
          }
          reply(call.id, "Checklist updated.");
          break;
        }
        case "dispatch": {
          const subagent = String(a.subagent ?? "");
          const itemIds = Array.isArray(a.checklist_item_ids) ? a.checklist_item_ids.map(String) : [];
          const brief = String(a.brief ?? "").trim();
          const exhausted = itemIds.filter((id) => (checklist.find((c) => c.id === id)?.failures ?? 0) >= rt.maxRetries);
          if (!names.includes(subagent)) {
            reply(call.id, `Rejected: unknown specialist "${subagent}". Available: ${names.join(", ")}.`);
            rejected.push(subagent);
          } else if (!brief) {
            reply(call.id, "Rejected: the brief is empty.");
            rejected.push(subagent);
          } else if (itemIds.length > 0 && exhausted.length === itemIds.length) {
            reply(call.id, `Rejected: retry limit (${rt.maxRetries}) reached for ${exhausted.join(", ")}. Report this to the user instead of retrying.`);
            rejected.push(subagent);
          } else {
            pending.push({ id: call.id, subagent, brief, checklistItemIds: itemIds });
          }
          break;
        }
        case "ask_user":
          final = { status: "needs_user", text: String(a.question ?? "I need more information to continue.") };
          reply(call.id, "Question sent to the user.");
          break;
        case "finish": {
          const status = a.status === "partial" || a.status === "failed" ? a.status : "done";
          final = { status, text: String(a.summary ?? response.content ?? "") };
          reply(call.id, "Turn finished.");
          break;
        }
        default:
          reply(call.id, `Error: unknown action "${call.function.name}".`);
      }
    }

    // Finishing and dispatching in the same breath: the finish wins, dispatches are answered.
    if (final && pending.length) {
      for (const d of pending) reply(d.id, "Not dispatched: the turn was finished in the same step.");
      pending.length = 0;
    }
    if (!final && response.toolCalls.length === 0) {
      if (response.content) final = { status: "done", text: response.content };
      else replies.push({ role: "user", content: "Use your tools: set_checklist, dispatch, update_checklist, ask_user, or finish." });
    }

    rt.trace.emit("supervisor_decision", "supervisor", {
      round: rounds,
      checklist,
      dispatches: pending.map((d) => ({ subagent: d.subagent, checklistItemIds: d.checklistItemIds, brief: d.brief })),
      rejected,
      final: final ? { status: final.status } : null,
    });

    return { messages: [assistant, ...replies], checklist, pending, applied, rounds, final };
  };

  const subagentNode = (def: SubagentDef) => async (input: { dispatch: Dispatch }, config: LangGraphRunnableConfig): Promise<Partial<State>> => {
    const rt = runtimeOf(config);
    const { dispatch } = input;
    const result = await runSubagent({
      def,
      dispatchId: dispatch.id,
      brief: dispatch.brief,
      checklistItemIds: dispatch.checklistItemIds,
      model: rt.model,
      tools: rt.subagentTools.get(def.name) ?? [],
      facts: rt.facts,
      maxSteps: rt.maxRounds,
      executor: rt.executor,
      trace: rt.trace,
      signal: rt.signal,
      parentTraceId: null,
    });
    let report = JSON.stringify({ status: result.status, summary: result.summary, evidence: result.evidence, data: result.data ?? null, steps: result.steps });
    if (report.length > MAX_REPORT_CHARS) report = `${report.slice(0, MAX_REPORT_CHARS)}…[report truncated]`;
    return { messages: [{ role: "tool", tool_call_id: dispatch.id, content: report }], results: [result] };
  };

  // Node names are only known at runtime (from the registry), which LangGraph's builder types
  // can't express — hence the untyped builder. The shape is enforced by the edges below.
  const builder = new StateGraph(TurnState) as unknown as {
    addNode: (name: string, fn: unknown) => typeof builder;
    addEdge: (from: string, to: string) => typeof builder;
    addConditionalEdges: (from: string, route: (s: State) => unknown, targets: string[]) => typeof builder;
    compile: () => {
      invoke: (input: Partial<State>, config: Record<string, unknown>) => Promise<State>;
      getGraph: () => { edges: Array<{ source: string; target: string; conditional?: boolean }> };
    };
  };
  builder.addNode("supervisor", supervisor);
  for (const def of subagents) builder.addNode(def.name, subagentNode(def));

  builder.addEdge(START, "supervisor");
  builder.addConditionalEdges(
    "supervisor",
    (state: State) => {
      if (state.final) return END;
      if (state.pending.length) return state.pending.map((d) => new Send(d.subagent, { dispatch: d }));
      return "supervisor";
    },
    [...names, "supervisor", END],
  );
  // Hub-and-spoke: every subagent returns to the supervisor. No other edges exist.
  for (const name of names) builder.addEdge(name, "supervisor");

  return builder.compile();
}

/** The compiled topology, read back from LangGraph itself (for the hub-and-spoke test). */
export function compiledEdges(): Array<{ source: string; target: string; conditional?: boolean }> {
  registerBuiltInSubagents();
  return buildGraph(listSubagents()).getGraph().edges;
}

export interface AgentRunnerDeps {
  mcp: McpClientManager;
  approvals: ApprovalGate;
  locks: ResourceLockManager;
  traces: TraceStore;
  policy: () => { allowScreenshotsToModel: boolean };
}

export interface TurnRequest {
  turnId: string;
  userText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  retryPolicy: { maxRetries: number; maxLoopIterations: number };
}

export class AgentRunner {
  private readonly graph: ReturnType<typeof buildGraph>;
  private controller: AbortController | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly deps: AgentRunnerDeps,
  ) {
    registerBuiltInSubagents();
    this.graph = buildGraph(listSubagents());
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  cancel(): void {
    this.controller?.abort(new Error("Stopped by the user."));
  }

  private async environment(trace: TurnTrace): Promise<EnvironmentFacts> {
    const facts: EnvironmentFacts = { now: new Date() };
    try {
      const result = await this.deps.mcp.callTool("get_displays", {}, { timeoutMs: 10_000 });
      const first = result.content?.[0];
      if (first?.type === "text") facts.displays = JSON.parse(first.text);
    } catch (error) {
      trace.emit("error", "system", { message: `could not read display layout: ${(error as Error).message}` });
    }
    return facts;
  }

  async run(request: TurnRequest): Promise<TurnOutcome> {
    if (this.controller) throw new Error("A turn is already running in this session.");
    const controller = new AbortController();
    this.controller = controller;
    const trace = this.deps.traces.forTurn(this.sessionId, request.turnId);
    const started = Date.now();
    trace.emit("agent_start", "system", { request: request.userText, model: request.model, retryPolicy: request.retryPolicy });

    let outcome: TurnOutcome;
    try {
      await this.deps.mcp.start();
      const facts = await this.environment(trace);
      const allTools = this.deps.mcp.tools.map(toFunctionTool);
      const subagentTools = new Map(listSubagents().map((s) => [s.name, allTools.filter((t) => s.selectTools(t.function.name))]));

      const runtime: TurnRuntime = {
        model: request.model,
        facts,
        trace,
        executor: new ToolExecutor(
          { mcp: this.deps.mcp, approvals: this.deps.approvals, locks: this.deps.locks, policy: this.deps.policy },
          { sessionId: this.sessionId, turnId: request.turnId, trace, signal: controller.signal },
        ),
        signal: controller.signal,
        maxRounds: request.retryPolicy.maxLoopIterations,
        maxRetries: request.retryPolicy.maxRetries,
        subagentTools,
      };

      const history: ChatMessage[] = request.history.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
      const state = await this.graph.invoke(
        { messages: [...history, { role: "user", content: request.userText }] },
        // Each round is a supervisor step plus a (parallel) subagent step.
        { recursionLimit: runtime.maxRounds * 2 + 10, configurable: { runtime } },
      );
      outcome = state.final ?? { status: "error", text: "The run ended without a result." };
    } catch (error) {
      if (controller.signal.aborted) outcome = { status: "cancelled", text: "Stopped. Nothing further will run for this request." };
      else {
        const message = error instanceof Error ? error.message : String(error);
        trace.emit("error", "system", { message });
        outcome = { status: "error", text: `Something went wrong while working on this: ${message}` };
      }
    } finally {
      this.controller = null;
    }

    trace.emit("message_end", "supervisor", { text: outcome.text });
    trace.emit("agent_end", "system", { status: outcome.status, ms: Date.now() - started });
    return outcome;
  }
}
