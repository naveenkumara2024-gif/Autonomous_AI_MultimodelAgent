/**
 * AI-generated session titles (prompts/ai-title-generation.md).
 *
 * This is a standalone utility, not part of the LangGraph.js supervisor
 * (section 10) — it never reads a session's own `model` field and the
 * supervisor/subagents never call through here. TITLE_GEN_MODEL is fixed to
 * `nemotron-3-ultra-free` and is swapped only on explicit instruction (see
 * prompts/ai-title-generation.md decision 8) — never inferred or changed
 * opportunistically by this code.
 *
 * Failure is always non-fatal: a missing/invalid key, a network error, a
 * timeout, or a malformed response all resolve to `null` so the caller can
 * fall back to the existing truncated title. Nothing here ever throws.
 */

export const TITLE_MAX_LENGTH = 60;

// The free title model's latency varies (measured 2.5–7.2s); 8s timed out in practice. The
// call is fire-and-forget and never blocks sending a message, so a generous bound costs nothing.
const REQUEST_TIMEOUT_MS = 20_000;
// nemotron-3-ultra-free is a reasoning model: its hidden reasoning is billed against
// max_tokens, and at 20 the title itself sometimes came back empty. The visible title is still
// capped by sanitizeTitle(), so a larger budget only gives the reasoning room to finish.
const MAX_RESPONSE_TOKENS = 400;

// The request is framed as DATA to be named, not a message to respond to: without that, the
// model answered knowledge questions instead of titling them (a Wikipedia request came back
// titled with the article's first sentence).
const SYSTEM_PROMPT =
  "You name chat sessions. You will be shown a user's request inside <request> tags. " +
  "Do NOT answer it, carry it out, or add information — only write a short title describing what the user wants. " +
  "Reply with the title text only: 3-7 words, no quotes, no trailing punctuation, no preamble.";

function titleRequest(userPrompt: string): string {
  return `<request>\n${userPrompt}\n</request>\n\nTitle for this request:`;
}

export interface GenerateTitleDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function sanitizeTitle(raw: string): string | null {
  let title = raw.trim().replace(/\s+/g, " ");
  // Models routinely wrap the answer in quotes despite being told not to.
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!title) return null;
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH)}…` : title;
}

/**
 * Calls the dedicated title-generation model to produce a short title for
 * `userPrompt`. Returns `null` on any failure — callers must keep their own
 * fallback title in that case, never block on this, and never throw it
 * upward.
 */
export async function generateTitle(
  userPrompt: string,
  deps: GenerateTitleDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const baseUrl = process.env.TITLE_GEN_BASE_URL;
  const apiKey = process.env.TITLE_GEN_API_KEY;
  const model = process.env.TITLE_GEN_MODEL;

  if (!baseUrl || !apiKey || !model) {
    console.warn(
      "[title-generator] TITLE_GEN_BASE_URL/TITLE_GEN_API_KEY/TITLE_GEN_MODEL not fully set — skipping AI title generation",
    );
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: titleRequest(userPrompt) },
        ],
        max_tokens: MAX_RESPONSE_TOKENS,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[title-generator] request failed with status ${res.status}`);
      return null;
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      console.warn("[title-generator] response missing choices[0].message.content");
      return null;
    }

    return sanitizeTitle(raw);
  } catch (err) {
    console.warn("[title-generator] request errored", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
