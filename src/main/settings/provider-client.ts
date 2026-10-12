import { hostOf } from "./provider-presets";

/**
 * "Test connection" and "Browse models" for the settings page. Runs in main so the API key
 * never reaches the renderer, and every message handed back is scrubbed of the key.
 */

export interface TestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  ms: number;
  /** HTTP status when the provider answered. */
  status?: number;
}

export interface ModelsResult {
  ok: boolean;
  models: string[];
  message?: string;
}

export interface ClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// The agent endpoint is a reasoning model with tens of seconds of latency (measured 46 s for a
// one-word reply), so a short timeout would report a working provider as broken.
const TEST_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 20_000;

function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("•••") : text;
}

/** Pulls `error.message` out of an OpenAI-style error body, falling back to the raw text. */
function providerMessage(body: string, apiKey: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const inner = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof inner === "string" && inner.trim()) text = inner.trim();
  } catch {
    // not JSON; use the raw text
  }
  return scrub(text.replace(/\s+/g, " ").slice(0, 200), apiKey);
}

export function describeHttpFailure(status: number, body: string, apiKey: string): string {
  const detail = providerMessage(body, apiKey);
  const suffix = detail ? ` — ${detail}` : "";
  if (status === 401 || status === 403) return `The provider rejected the API key (HTTP ${status})${suffix}`;
  if (status === 402) return `The account is out of credits (HTTP 402)${suffix}`;
  if (status === 404) return `Not found: check the base URL and the model name (HTTP 404)${suffix}`;
  if (status === 429) return `The key works but the provider is rate-limiting it (HTTP 429)${suffix}`;
  if (status >= 500) return `The provider is having trouble right now (HTTP ${status})${suffix}`;
  return `The provider returned HTTP ${status}${suffix}`;
}

function describeNetworkFailure(error: unknown, baseUrl: string, timeoutMs: number, apiKey: string): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return `No response from ${hostOf(baseUrl)} within ${Math.round(timeoutMs / 1000)} s.`;
  return scrub(`Couldn't reach ${hostOf(baseUrl)}: check the base URL and your connection.`, apiKey);
}

/** One 1-token chat completion with the configured model: proves URL, key and model together. */
export async function testProvider(input: TestInput, deps: ClientDeps = {}): Promise<TestResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TEST_TIMEOUT_MS;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    const body = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: res.status, ms, message: describeHttpFailure(res.status, body, input.apiKey) };

    let hasMessage = false;
    try {
      hasMessage = Boolean((JSON.parse(body) as { choices?: Array<{ message?: unknown }> }).choices?.[0]?.message);
    } catch {
      // handled below
    }
    if (!hasMessage) return { ok: false, status: res.status, ms, message: "The provider answered, but not in the OpenAI chat-completions format. Check the base URL." };
    return { ok: true, status: res.status, ms, message: `Connected to ${hostOf(input.baseUrl)}. ${input.model} replied in ${(ms / 1000).toFixed(1)} s.` };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, message: describeNetworkFailure(error, input.baseUrl, timeoutMs, input.apiKey) };
  }
}

/** `GET {base}/models` -> sorted model ids. Not every router exposes it; typing a name always works. */
export async function listModels(input: { baseUrl: string; apiKey: string }, deps: ClientDeps = {}): Promise<ModelsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? MODELS_TIMEOUT_MS;
  try {
    const res = await fetchImpl(`${input.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      const why = res.status === 404 ? "This provider doesn't list its models. Type the model name instead." : describeHttpFailure(res.status, body, input.apiKey);
      return { ok: false, models: [], message: why };
    }
    const parsed = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
    const ids = (parsed.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { ok: false, models: [], message: "The provider returned no models. Type the model name instead." };
    return { ok: true, models: [...new Set(ids)].sort((a, b) => a.localeCompare(b)) };
  } catch (error) {
    const timedOut = (error as { name?: string } | null)?.name === "TimeoutError";
    return { ok: false, models: [], message: timedOut ? describeNetworkFailure(error, input.baseUrl, timeoutMs, input.apiKey) : "Couldn't read a model list from this provider. Type the model name instead." };
  }
}
