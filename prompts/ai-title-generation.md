# AI-generated session titles

## Goal
Replace the placeholder "first message, truncated to 60 chars" title logic (`session-manager.ts`,
Stage-1 decision 8 — explicitly deferred to a later stage) with a real AI-generated title: on the
session's first user message, call an LLM to produce a short, content-aware title via a
`generateTitle()` function. If the user has manually renamed a session (`renameSession`), no
automatic process may ever overwrite that title again.

## Layers touched
`src/main/agent/` (new — first file in this directory; `agent-runner.ts`/`subagent-registry.ts`
land in later stages per section 5, this is just the title-gen utility), `src/main/db/`,
`src/main/session/`, `src/renderer/types.ts`. No renderer UI changes needed — titles already flow
through the existing `session.update` event into `SessionList`/`TopBar`.

## Docs consulted
- AGENTS.md section 6 (lifecycle), section 7 (`Session` contract, IPC vocabulary), section 8
  ("Title-generation model: same primary model vs. a cheap dedicated one — a cost/latency
  tradeoff paid on every new session" — this feature answers that with a dedicated, separate
  cheap model, not the session's own `model` field), section 12 ("Title generation needs content
  to generate from; firing it before the first turn resolves produces a generic or empty title").
- `prompts/stage-1-session-core.md` decision 8 — confirms the truncation logic being replaced was
  always a placeholder, not a design decision to preserve.

## Code inspected
- `src/main/session/session-manager.ts` — `continueSession()`'s existing synchronous truncation
  (`TITLE_MAX_LENGTH = 60`) at the point it appends the first user message; `renameSession()`.
- `src/main/session/session-store.ts` — `updateTitle()`, row↔`Session` mapping.
- `src/main/db/database.ts` — `ensureColumn()` allowlist migration helper (schema-on-read, no
  migration framework).
- `src/main/config/config-store.ts` — global config lives in `<userData>/config.json`, not
  suitable for secrets (would put an API key in a plain JSON file); confirms env vars are the
  right place for credentials, not this store.
- `src/main/index.ts` / `client-event-utils.ts` / `src/preload/index.ts` / `vite-env.d.ts` — the
  `registerHandler` + `agentBridge` + ambient-type wiring pattern (no new IPC channel needed here;
  title updates ride the existing `session.update` event).
- `src/renderer/App.tsx` — confirms `TopBar` already blanks the title until it's not `"New
  session"` (comment at line ~181 already anticipates this feature landing here).
- `package.json` — no HTTP client dependency exists; `bun test` is the test runner, no test files
  exist yet in the repo (this will be the first).
- `.gitignore` — `.env*` is already ignored; no `.env` file exists yet.

## Decisions / assumptions (flagging for approval)

1. **New `title_source` column** (`'auto' | 'manual'`, default `'auto'`) on `sessions`, added via
   the existing `ensureColumn()` allowlist — this is the only reliable way to know "did a human
   rename this" independent of what the title string currently says. `renameSession()` is the only
   code path that ever sets it to `'manual'`; once manual, no automatic process may write the
   title again for that session.
2. **Two-stage title, not a single blocking AI call.** `continueSession()` keeps today's
   synchronous truncated title as an instant fallback (unchanged latency on send), then fires
   `generateTitle()` **asynchronously** (not awaited) and applies the AI result only if it resolves
   *and* the session is still `title_source: 'auto'` at that moment (re-checked from the store, not
   from the closure, to close the race against a manual rename happening while the call is
   in-flight). If the call fails, times out, or no API key is configured, the truncated fallback
   title simply stands — the feature degrades, it never throws or blocks message send.
3. **New file `src/main/agent/title-generator.ts`, not folded into `session-manager.ts`.** This is
   the first thing to live under `agent/` (section 5's planned home for `agent-runner.ts` /
   `subagent-registry.ts` in later stages) since it's model-calling code, not persistence code.
   Exports `generateTitle(userPrompt: string, deps?: { fetchImpl?: typeof fetch }): Promise<string
   | null>` — the `deps.fetchImpl` seam is for the smoke test, so tests inject a mock instead of
   monkey-patching the global.
4. **Credentials via environment variables, not `config-store.ts`.** `TITLE_GEN_BASE_URL`,
   `TITLE_GEN_API_KEY`, `TITLE_GEN_MODEL`. `config.json` is a plain unencrypted file this project
   already treats as non-secret global defaults (model name, retry policy) — an API key doesn't
   belong there. I'll write a real local `.env` (already gitignored, confirmed above — never
   committed) with the credentials you pasted, plus a committed `.env.example` with placeholders
   documenting the three variables for anyone else setting this up.
   - **Flag:** that key was pasted directly into this chat, which is logged. Worth rotating it at
     `router.bynara.id` once you've confirmed the feature works, since anyone with the transcript
     has it.
5. **Bounded, non-destructive network call — not routed through `risk-classifier.ts`.** Section 3
   says every *dispatched tool call* passes the risk classifier; this isn't a tool call or agent
   action, it's app infrastructure (same category as `config-store.ts` writing local JSON) with a
   single fixed, hardcoded destination and no side effects beyond a title string, using an
   `AbortController` timeout (20s — raised from 8s after the free model measured 2.5–7.2s in practice) so a hung request can't block anything indefinitely. **Flag:**
   it does send the user's first-message text (not a screenshot, not redacted content — just what
   they typed) to a third-party endpoint. That's real network egress with user content, which is
   worth you knowing about explicitly even though `risk-classifier.ts`/the approval gate don't
   exist yet and wouldn't gate this even if they did (they gate tool dispatch, not all outbound
   calls). If you'd rather title generation be opt-out-able, say so and I'll add a config flag —
   defaulting to always-on for now since you asked for this by default.
6. **Sanitization on the AI's output**: trim whitespace/quotes the model tends to wrap titles in,
   collapse newlines, and still cap at the existing `TITLE_MAX_LENGTH = 60` as a hard safety net
   even though the system prompt asks for something shorter — models don't always obey length
   instructions.
7. **Endpoint shape**: OpenAI-compatible `POST {baseUrl}/chat/completions` (the base URL you gave
   ends in `/v1`, and `nemotron-3-ultra-free` is passed as `model`) — no new dependency needed,
   Node 22's built-in `fetch` (which Electron 41 bundles) is sufficient.
8. **This model is exclusively for title generation and must stay isolated from the main agent
   workflow.** `TITLE_GEN_MODEL` is a standalone env var, never read by (or merged into) a
   session's own `model` field or any future `agent-runner.ts` model selection — title generation
   calls `title-generator.ts`'s own fixed endpoint/model, nothing else in the app ever calls
   through this path, and nothing here changes what model the supervisor/subagents use once they
   exist. I won't swap `nemotron-3-ultra-free` for anything else unless you explicitly say so.

## Files to touch

Create:
- `src/main/agent/title-generator.ts` — `generateTitle()`.
- `src/main/agent/title-generator.test.ts` — smoke test (`bun test`), mocked `fetchImpl`, no real
  network call in the automated test (so it stays fast and doesn't spend real API credit on every
  `bun test` run).
- `.env.example` — documents `TITLE_GEN_BASE_URL`, `TITLE_GEN_API_KEY`, `TITLE_GEN_MODEL` with
  placeholder values.
- `.env` — your real local credentials (gitignored, never committed).

Modify:
- `src/main/db/database.ts` — add `title_source TEXT NOT NULL DEFAULT 'auto'` via `ensureColumn`.
- `src/main/session/session-store.ts` — `Session.titleSource`, `updateTitle(id, title, source)`.
- `src/main/session/session-manager.ts` — keep instant truncated fallback, fire-and-forget
  `generateTitle()` call that re-checks `titleSource` before applying; `renameSession()` now sets
  `titleSource: 'manual'`.
- `src/renderer/types.ts` — mirror `titleSource` on the renderer's `Session` type (already
  duplicated from `session-store.ts` per the existing pattern in `vite-env.d.ts`).

## Safety implications
- First outbound network call in the codebase — see decision 5's flag above.
- No destructive action, no file writes beyond the session's own title, no tool dispatch — outside
  the scope of `risk-classifier.ts`/`approval-gate.ts` (which don't exist yet regardless).
- Failure mode is always "keep the truncated fallback title," never a crash, never a blocked
  message send, never a retry storm (single attempt, no retry loop — nothing here needs
  `retryPolicy` since there's no user-visible consequence to a dropped title refinement).
- API key handling: env var + gitignored `.env`, flagged for rotation since it was pasted in chat.

## Acceptance criteria
1. New session, first message sent → title updates (visibly, once the async call resolves) to an
   AI-generated title reflecting that message's content, not just a truncated substring.
2. If `TITLE_GEN_API_KEY` is unset/invalid, or the endpoint is unreachable → session still gets the
   truncated fallback title, no error surfaced to the renderer, no crash.
3. Manually renaming a session (`renameSession`) at any point — including while a `generateTitle()`
   call for that session is still in flight — means the AI result, whenever it resolves, is
   discarded, not applied. The manual title stands.
4. A second message to an already-titled session never re-triggers title generation (only fires on
   the session's first user message, same as today's truncation trigger).
5. `bun test` — new smoke test passes, covers: successful generation, non-OK HTTP response, missing
   API key (fetch never called), and truncation of an overlong AI response.
6. `bun run typecheck` clean.

## Manual test steps
1. Set real credentials in `.env` (already written for you).
2. `bun run dev`. Create a session, send a first message like "help me plan a trip to Kyoto next
   spring". Confirm the title updates shortly after to something like "Kyoto Spring Trip Planning"
   rather than the raw truncated sentence.
3. Rename that session manually via the sidebar to something else, then send a second message.
   Confirm the manual title is never overwritten.
4. Temporarily blank `TITLE_GEN_API_KEY` in `.env`, restart, send a first message on a new session.
   Confirm it falls back to the truncated title with no console error breaking the flow.
5. `bun test` — confirm the new smoke test file passes, and note whether I actually exercised the
   real endpoint once by hand to confirm end-to-end wiring (I'll ask before spending a real API
   call on that, separate from the automated mocked test).
