import type { FunctionTool } from "../mcp/tool-adapter";
import type { TurnTrace } from "./trace";

/**
 * Thin OpenAI-compatible chat-completions client for the agent (AGENT_* env vars —
 * deliberately separate from title-generator.ts's TITLE_GEN_* model, which stays isolated).
 * Our own fetch rather than a LangChain chat model so every request can be traced exactly:
 * model, message/tool counts, tokens, latency, finish reason, retries. Bounded retries on
 * 429/5xx/network errors only; honors the turn's AbortSignal; never logs the API key.
 */

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  ms: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: FunctionTool[];
  /** "required" forces a tool call — used so agents always act or report, never just chat. */
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  trace: TurnTrace;
  actor: string;
  parentId?: string | null;
  /** Short label for the trace row, e.g. "plan", "step 3". */
  purpose: string;
}

const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [1000, 3000];

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.AGENT_BASE_URL;
  const apiKey = process.env.AGENT_API_KEY;
  if (!baseUrl || !apiKey) throw new LlmError("AGENT_BASE_URL / AGENT_API_KEY are not set (see .env.example).");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function countImages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === "user" && Array.isArray(m.content)) n += m.content.filter((p) => p.type === "image_url").length;
  return n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function chat(request: ChatRequest): Promise<ChatResult> {
  const { baseUrl, apiKey } = config();
  const body = {
    model: request.model,
    messages: request.messages,
    ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" } : {}),
    max_tokens: request.maxTokens ?? 2048,
    temperature: request.temperature ?? 0.2,
  };

  const requestId = request.trace.emit(
    "llm_request",
    request.actor,
    {
      purpose: request.purpose,
      model: request.model,
      messages: request.messages.length,
      images: countImages(request.messages),
      tools: request.tools?.length ?? 0,
      toolChoice: body.tool_choice ?? null,
    },
    request.parentId ?? null,
  );

  const start = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 400);
        throw new LlmError(`Model request failed: HTTP ${res.status} ${detail}`, res.status);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }>;
        usage?: ChatResult["usage"];
      };
      const choice = json.choices?.[0];
      if (!choice?.message) throw new LlmError("Model response had no choices[0].message.");

      const result: ChatResult = {
        content: (choice.message.content ?? "").trim(),
        toolCalls: (choice.message.tool_calls ?? []).filter((t) => t?.function?.name),
        finishReason: choice.finish_reason ?? "unknown",
        usage: json.usage ?? {},
        ms: Date.now() - start,
      };
      request.trace.emit(
        "llm_response",
        request.actor,
        {
          purpose: request.purpose,
          model: request.model,
          ms: result.ms,
          finishReason: result.finishReason,
          usage: result.usage,
          toolCalls: result.toolCalls.map((t) => t.function.name),
          contentPreview: result.content.slice(0, 300),
          retries: attempt,
        },
        requestId,
      );
      return result;
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      lastError = error;
      const status = error instanceof LlmError ? error.status : undefined;
      const retryable = status === undefined ? !(error instanceof LlmError) : status === 429 || status >= 500;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) break;
      request.trace.emit("error", request.actor, { message: `model request failed, retrying in ${delay}ms: ${String((error as Error).message ?? error)}` }, requestId);
      await sleep(delay, request.signal);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  request.trace.emit("llm_response", request.actor, { purpose: request.purpose, model: request.model, ms: Date.now() - start, error: message }, requestId);
  throw lastError instanceof Error ? lastError : new LlmError(message);
}

/** Tool-call arguments arrive as a JSON string; malformed JSON becomes a readable error. */
export function parseToolArgs(call: ToolCall): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, args: parsed as Record<string, unknown> };
    return { ok: false, error: "arguments must be a JSON object" };
  } catch (error) {
    return { ok: false, error: `arguments are not valid JSON: ${(error as Error).message}` };
  }
}
