# LLM provider failover for the agent: Bynara -> OpenRouter free -> last resort

> **Superseded by `prompts/settings-providers.md`** (a settings UI with selectable providers). This
> failover design was never implemented; it is kept for the privacy and failure-semantics notes.

## Goal
When the agent's model request fails, retry it on the next provider in a fixed priority list
instead of failing the turn. Today `agent/llm-client.ts` talks to exactly one endpoint
(`AGENT_BASE_URL`) with one model (`session.model`, now `agnes-2.5-flash`); if that endpoint is
down, out of credits, or the model is unavailable, the whole turn errors out.

Requested order:
1. the existing provider (Bynara router, `agnes-2.5-flash`)
2. OpenRouter's free router, model `openrouter/free`
3. "nararouter" (see assumption 1)

## Layers touched
Agent model client only (`src/main/agent/`), config, `.env.example`, preflight reporting. The
supervisor graph, subagents, risk classifier, approval gate, resource locks, overlay and MCP server
are **not** touched. Title generation (`title-generator.ts`, `TITLE_GEN_*`) stays isolated, as its
own header comment requires.

## Docs consulted
- AGENTS.md §3 (every loop bounded; no raw screenshot leaves the device before redaction), §10
  (retries are the supervisor's, capped by `retryPolicy`), §14 (safety over autonomy).
- `prompts/stage-3-mcp-automation-agent.md` decision 4 (model config separate from title gen).
- OpenRouter docs: OpenAI-compatible `POST https://openrouter.ai/api/v1/chat/completions`, Bearer
  key; `openrouter/free` is a router that picks a free model matching the request's needs (e.g.
  images, tools).

## Code inspected
- `agent/llm-client.ts` — single `chat()`; reads `AGENT_BASE_URL`/`AGENT_API_KEY` per call; 90 s
  per-attempt timeout; 2 retries (1 s, 3 s) on 429/5xx/network only; 4xx other than 429 are not
  retried; traces `llm_request` / `llm_response` with `model`, `ms`, `usage`; never logs the key.
- Callers: `agent-runner.ts` (supervisor), `subagent-loop.ts`; both pass `model: session.model`.
- `perception/voice-translator.ts` has its **own** fetch against `AGENT_*` (not `chat()`).
- `.env` currently defines `TITLE_GEN_*` and `AGENT_BASE_URL` / `AGENT_API_KEY` only — **there is no
  OpenRouter key yet**, so tier 2 cannot work until one is added.
- Measured earlier this session: one 16-token request to `agnes-2.5-flash` took ~46 s, so a tight
  per-tier timeout would cause false failovers.

## Decisions / assumptions (flagging for approval)

1. **"nararouter" is read as the existing Bynara router (`router.bynara.id`, a typo/alias) used as
   the last tier with a different, cheaper model.** Tier 3 = `AGENT_BASE_URL` + `AGENT_API_KEY` with
   `fallbackModel` (default `agnes-3-flash`, the model that worked before today). *If you meant a
   separate third service, I need its base URL, key and model; the chain supports that through
   three optional env vars (below) and I'd simply fill them in.*
2. **Failover is per request, ordered, and stateless between turns except a short cool-down.** A
   provider is tried; on failure (after its own existing retry policy) the same request goes to the
   next. A provider that failed is skipped for **2 minutes** so later calls in the same turn go
   straight to the working tier instead of waiting out another timeout. If every tier is in
   cool-down or fails, the error from the *first* tier is surfaced (the one the user configured).
3. **What counts as a failure:** network error, timeout, HTTP 429 / 5xx **and** 4xx (401, 402
   "insufficient credits", 404 "model not found", 400 for an unsupported parameter such as
   `tool_choice`), or a response with no `choices[0].message`. **Not** a failure: the user
   cancelling the turn (the abort signal). An empty/odd *reply* from a working provider is not a
   failover trigger, because the agent loop already handles "no tool call".
4. **Each tier uses its own model name; the session's model applies to tier 1 only.** Tier 2 always
   sends `openrouter/free`; tier 3 sends `fallbackModel`. (A Bynara model name means nothing to
   OpenRouter.)
5. **Bounded.** At most 3 tiers per request, each with the existing bounded retry (2 retries). Worst
   case before giving up is 3 x the current worst case, which is why the cool-down exists. This
   happens *inside one* `chat()` call, so it does not consume the supervisor's
   `maxLoopIterations` / `maxRetries`.
6. **Secrets stay in `.env`; order and model names live in `config.json`.**
   ```
   AGENT_BASE_URL / AGENT_API_KEY      tier 1 and tier 3 (unchanged)
   OPENROUTER_API_KEY                  tier 2 (new; tier 2 is skipped when empty)
   OPENROUTER_BASE_URL                 optional, default https://openrouter.ai/api/v1
   FALLBACK_BASE_URL / FALLBACK_API_KEY   optional; when set, tier 3 uses these instead of AGENT_*
   ```
   `config.json`: `fallbackModel` (default `agnes-3-flash`), `openrouterModel` (default
   `openrouter/free`), `agentFailoverEnabled` (default `true`; `false` = exactly today's single
   provider behaviour).
7. **Visible in the trace.** `llm_request` / `llm_response` gain a `provider` field
   (`bynara` / `openrouter` / `fallback`) next to `model`, and a switch emits one `error`-type
   trace row ("`bynara` failed (HTTP 402 ...); trying `openrouter`"), so TracePanel and the
   overlay show *why* a step ran on another model. Keys are never traced (as today).
8. **Not doing:** changing the voice translator or title generator to use the chain (the translator
   duplicates its own fetch; moving it onto `chat()` is a separate cleanup), health-checking
   providers in the background, per-subagent provider choice, or a settings UI (none exists).

## Safety implications (read these)
- **Screen content and prompts now reach up to three third parties.** Redaction
  (`perception/redactor.ts`, `allowScreenshotsToModel`) is applied upstream of `chat()` and is
  unchanged, so a fallback sees exactly what tier 1 would have — redacted — but it is *more places*.
  **Free OpenRouter models are frequently operated by providers that may log prompts and use them
  for training; I have not verified the policy of whichever model `openrouter/free` picks.** For
  that reason a new `fallbackSendImages` config (default `true`, as you asked for image
  understanding) lets you strip images from tiers 2/3; with `false` those tiers get text-only
  requests and the agent falls back to UI Automation / DOM tools.
- Tool-calling quality varies a lot across free models. A fallback model may produce malformed or
  absent tool calls; every call still goes through the classifier / approval gate / locks, so this
  costs reliability, not safety.
- The key for each tier is read only for that tier's request and never written to trace, logs or
  the renderer. `.env.example` gets placeholders only.

## Files to touch
Create:
- `src/main/agent/llm-providers.ts` — pure: `buildProviderChain(env, config, sessionModel)` and a
  small `CooldownTracker` (injected clock). No `fetch`, no Electron.
- `src/main/agent/llm-providers.test.ts`, `src/main/agent/llm-client.test.ts` (stubs
  `globalThis.fetch`).

Modify:
- `src/main/agent/llm-client.ts` — iterate the chain; keep the existing per-provider retry loop;
  add `provider` to the trace rows; strip `image_url` parts for tiers that disallow them.
- `src/main/config/config-store.ts` — `agentFailoverEnabled`, `openrouterModel`, `fallbackModel`,
  `fallbackSendImages`.
- `.env.example` — the new variables, placeholders only.
- `src/main/preflight.ts` — report which tiers are configured (`tier 2 skipped: OPENROUTER_API_KEY
  not set`), not fail on a missing optional tier.

## Acceptance criteria
1. With all tiers healthy, behaviour and requests are byte-identical to today (tier 1 only).
2. Tier 1 returning 5xx / 402 / 404 / timing out -> the same request succeeds on tier 2 and the
   trace shows the switch and the provider that answered.
3. Tier 1 and tier 2 both failing -> tier 3 answers; all three failing -> the tier-1 error is
   thrown (so the existing error handling and message are unchanged).
4. After tier 1 fails, the next `chat()` within 2 minutes does not call tier 1; after 2 minutes it
   is tried again first.
5. A user cancel during any tier aborts immediately and does **not** trigger the next tier.
6. `OPENROUTER_API_KEY` unset -> tier 2 skipped silently (noted once in preflight), tier 3 still
   works.
7. `agentFailoverEnabled: false` -> exactly one provider, today's error behaviour.
8. `fallbackSendImages: false` -> requests to tiers 2/3 contain no `image_url` parts; tier 1 is
   unaffected.
9. No API key appears in any trace row, log line or test snapshot.
10. `bun run typecheck`, `bun test`, `bun run build` pass with real output reported.

## Manual test steps
1. Add `OPENROUTER_API_KEY=...` to `.env`; restart. Check preflight lists tiers 1-3.
2. Temporarily set `AGENT_API_KEY` to an invalid value; send a prompt; confirm the trace shows
   `bynara failed (HTTP 401...)` then an answer from `openrouter`, and that a second prompt within
   2 minutes goes straight to `openrouter`.
3. Also break the OpenRouter key; confirm tier 3 answers (needs the valid key back for tier 3 if it
   shares `AGENT_*`; with `FALLBACK_*` set it works independently).
4. Restore the keys; confirm the next prompt after the cool-down uses tier 1 again.

## Open assumptions (flag if wrong)
- "nararouter" = the Bynara router (assumption 1). This is the one that changes what I build.
- `openrouter/free` accepts `tools` / `tool_choice: "required"` and `image_url` parts the way the
  user described; I will check it with one real request once a key exists, and report what comes
  back rather than assume.
- OpenRouter free tiers are rate-limited (I believe ~20 requests/minute and a daily cap without
  credits; **not verified for your account**), so tier 2 can itself return 429 under a busy turn.
