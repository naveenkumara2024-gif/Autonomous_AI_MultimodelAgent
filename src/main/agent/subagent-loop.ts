import type { FunctionTool } from "../mcp/tool-adapter";
import type { ToolCallOutcome, ToolExecutor } from "../tools/tool-executor";
import { resolveResources } from "../tools/resource-resolvers";
import { type ChatMessage, chat, type ContentPart, parseToolArgs, type ToolCall } from "./llm-client";
import { type EnvironmentFacts, REPORT_TOOL } from "./prompts/shared";
import type { SubagentDef } from "./subagent-registry";
import type { TurnTrace } from "./trace";

/**
 * One subagent working one brief: a bounded tool-calling loop (AGENTS.md section 3: every loop
 * is bounded). The subagent never retries itself after it gives up and never hands off to
 * another subagent — it finishes with a `report` that goes back to the supervisor, which owns
 * retries and routing (section 10).
 */

export type SubagentStatus = "done" | "failed" | "blocked" | "cancelled";

export interface SubagentResult {
  dispatchId: string;
  subagent: string;
  checklistItemIds: string[];
  status: SubagentStatus;
  summary: string;
  evidence: string;
  data?: unknown;
  steps: number;
}

export interface SubagentRunInput {
  def: SubagentDef;
  dispatchId: string;
  brief: string;
  checklistItemIds: string[];
  model: string;
  tools: FunctionTool[];
  facts: EnvironmentFacts;
  maxSteps: number;
  executor: ToolExecutor;
  trace: TurnTrace;
  signal: AbortSignal;
  parentTraceId: string | null;
}

// Screenshots dominate context size and cost. Only the most recent ones stay as images; older
// ones collapse to a placeholder (the text results that came with them remain).
const MAX_IMAGES_IN_CONTEXT = 2;
const MAX_NUDGES = 2;

function pruneImages(messages: ChatMessage[]): ChatMessage[] {
  let kept = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const parts: ContentPart[] = m.content.map((p) => {
      if (p.type !== "image_url") return p;
      if (kept < MAX_IMAGES_IN_CONTEXT) {
        kept++;
        return p;
      }
      return { type: "text", text: "[older screenshot removed to save context]" };
    });
    out[i] = { role: "user", content: parts };
  }
  return out;
}

/**
 * Runs a response's tool calls in the order the model wrote them — a click followed by a
 * type_text must not be reordered — while letting consecutive pure observations (calls that
 * hold no resources) run in parallel with each other.
 */
async function executeInOrder(calls: ToolCall[], run: (call: ToolCall) => Promise<ToolCallOutcome | string>): Promise<Array<ToolCallOutcome | string>> {
  const results: Array<ToolCallOutcome | string> = new Array(calls.length);
  let i = 0;
  while (i < calls.length) {
    const parsed = parseToolArgs(calls[i]!);
    const isObservation = parsed.ok && resolveResources(calls[i]!.function.name, parsed.args).length === 0;
    if (!isObservation) {
      results[i] = await run(calls[i]!);
      i++;
      continue;
    }
    let j = i;
    const batch: number[] = [];
    while (j < calls.length) {
      const p = parseToolArgs(calls[j]!);
      if (!(p.ok && resolveResources(calls[j]!.function.name, p.args).length === 0)) break;
      batch.push(j++);
    }
    const outcomes = await Promise.all(batch.map((k) => run(calls[k]!)));
    batch.forEach((k, n) => (results[k] = outcomes[n]!));
    i = j;
  }
  return results;
}

export async function runSubagent(input: SubagentRunInput): Promise<SubagentResult> {
  const { def, trace, signal, executor } = input;
  const base = { dispatchId: input.dispatchId, subagent: def.name, checklistItemIds: input.checklistItemIds };
  const toolNames = new Set(input.tools.map((t) => t.function.name));
  const tools = [...input.tools, REPORT_TOOL];

  const startId = trace.emit("subagent_start", def.name, { brief: input.brief, checklistItemIds: input.checklistItemIds, tools: input.tools.length, maxSteps: input.maxSteps }, input.parentTraceId);
  const end = (result: SubagentResult): SubagentResult => {
    trace.emit("subagent_end", def.name, { status: result.status, summary: result.summary, evidence: result.evidence, steps: result.steps }, startId);
    return result;
  };

  const messages: ChatMessage[] = [
    { role: "system", content: def.systemPrompt(input.facts, input.maxSteps) },
    { role: "user", content: `## Brief from the supervisor\n${input.brief}` },
  ];
  let nudges = 0;

  for (let step = 1; step <= input.maxSteps; step++) {
    if (signal.aborted) return end({ ...base, status: "cancelled", summary: "Stopped by the user.", evidence: "", steps: step - 1 });

    let response;
    try {
      response = await chat({
        model: input.model,
        messages: pruneImages(messages),
        tools,
        toolChoice: "required",
        signal,
        trace,
        actor: def.name,
        parentId: startId,
        purpose: `step ${step}`,
      });
    } catch (error) {
      if (signal.aborted) return end({ ...base, status: "cancelled", summary: "Stopped by the user.", evidence: "", steps: step - 1 });
      return end({ ...base, status: "failed", summary: `Model request failed: ${(error as Error).message}`, evidence: "", steps: step });
    }

    if (response.content) trace.emit("message_update", def.name, { text: response.content }, startId);
    messages.push({ role: "assistant", content: response.content || null, ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}) });

    if (response.toolCalls.length === 0) {
      if (++nudges > MAX_NUDGES) {
        return end({ ...base, status: "failed", summary: "Stopped: the model kept replying without acting or reporting.", evidence: response.content, steps: step });
      }
      messages.push({ role: "user", content: "Continue the brief: call a tool, or call `report` if you are finished, failed, or blocked." });
      continue;
    }

    const reportCall = response.toolCalls.find((c) => c.function.name === "report");
    const actionCalls = response.toolCalls.filter((c) => c !== reportCall);

    const outcomes = await executeInOrder(actionCalls, async (call) => {
      const parsed = parseToolArgs(call);
      if (!parsed.ok) return `Error: ${parsed.error}. Re-issue the call with valid JSON arguments.`;
      if (!toolNames.has(call.function.name)) return `Error: unknown tool "${call.function.name}". You can only use: ${[...toolNames].join(", ")}, report.`;
      return executor.execute({ tool: call.function.name, rawArgs: parsed.args, reasoningTrace: response.content, subagent: def.name, parentTraceId: startId });
    });

    const images: ContentPart[] = [];
    actionCalls.forEach((call, n) => {
      const outcome = outcomes[n]!;
      const text = typeof outcome === "string" ? outcome : outcome.text;
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
      if (typeof outcome !== "string") {
        for (const img of outcome.images) images.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      }
    });
    // Tool messages are text-only on most OpenAI-compatible backends, so images ride along in
    // a user message right after the results they belong to.
    if (images.length) messages.push({ role: "user", content: [{ type: "text", text: "Image(s) returned by the tool calls above:" }, ...images] });

    if (reportCall) {
      const parsed = parseToolArgs(reportCall);
      const r = parsed.ok ? parsed.args : {};
      const status = r.status === "done" || r.status === "failed" || r.status === "blocked" ? r.status : "failed";
      if (signal.aborted) return end({ ...base, status: "cancelled", summary: "Stopped by the user.", evidence: "", steps: step });
      return end({
        ...base,
        status,
        summary: typeof r.summary === "string" ? r.summary : parsed.ok ? "" : `Malformed report: ${parsed.error}`,
        evidence: typeof r.evidence === "string" ? r.evidence : "",
        data: r.data,
        steps: step,
      });
    }
  }

  return end({
    ...base,
    status: "failed",
    summary: `Reached the ${input.maxSteps}-step limit for one brief without finishing.`,
    evidence: messages.filter((m) => m.role === "assistant" && m.content).slice(-1).map((m) => String(m.content)).join(""),
    steps: input.maxSteps,
  });
}
