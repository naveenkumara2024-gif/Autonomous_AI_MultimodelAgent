# Stage 5 — Fast-path automation flows (deterministic dispatch for common requests)

## Goal
For request shapes that have exactly one obviously-correct action — starting with "open/start/
launch \<app\>" — skip the multi-round supervisor loop (plan → dispatch → find_element/screenshot
→ verify → finish, 4+ LLM calls, 35–100+ s measured in Stage 3's own end-to-end runs) and act
deterministically in well under a second, with the *same* safety pipeline and tracing, and an
automatic fallback to the normal agent loop if the deterministic path can't resolve confidently.

## Layers touched
`src/mcp-server/tools/` (new `launch_app` tool, callable by the fast path AND by the desktop
subagent), `src/main/agent/fast-paths/` (new — the pluggable registry + the first entry),
`src/main/agent/agent-runner.ts` (checks the registry before invoking the graph),
`src/main/tools/resource-resolvers.ts`.

## Docs consulted
- AGENTS.md section 7: `SubagentDef` / tool-call contract emphasize registry-driven,
  never-hardcoded dispatch — the fast-path registry mirrors that shape deliberately, so adding
  a second fast path later ("set volume to X", "mute", "take a screenshot") is a new file, not
  a change to `agent-runner.ts`.
  Section 14: "Keep subagents registry-driven, not hardcoded" — applied here to fast paths too.
  Section 3: every dispatched tool call still passes the risk classifier — a fast path is a
  *routing* shortcut, never a *safety* shortcut.
  Section 11: resources/locks are decided by the call's args, not by how it was dispatched — a
  fast-path `launch_app` call acquires the same `native-input`-adjacent... (see decision 5)
  lock as anything else touching the desktop, so it can't race a concurrent agent action.
- **Live-verified on this machine** (read-only + one reversible launch/close cycle):
  - `Get-StartApps` enumerates all 248 Start-menu-registered apps (UWP and classic) with a
    `Name`/`AppID` pair, in ~1.2s cold.
  - `explorer.exe shell:AppsFolder\<AppID>` launches BOTH a UWP app (Calculator —
    `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`, confirmed as process `CalculatorApp.exe`,
    then closed) and a classic Win32 app (Chrome — AppID `Chrome`, a self-registered
    AppUserModelID) — the same mechanism covers every Start-menu app without needing to locate
    an actual `.exe` path, which is the part that normally makes "just open the app" unreliable
    for packaged apps.

## Code inspected
- `src/mcp-server/tools/apps.ts`, `app-memory/app-store.ts` — the existing per-app
  memory/click-history store; `launch_app` is a sibling tool, not a rework of that.
- `src/main/agent/agent-runner.ts` `AgentRunner.run()` — where the graph is invoked; the fast
  path is checked once, before `this.graph.invoke(...)`, using the same `trace`/`executor`
  built for the turn, so a fast-path action produces ordinary `tool_execution_*` trace events
  indistinguishable in shape from an agent-dispatched one.
- `src/main/agent/subagents/desktop-subagent.ts` — its tool allowlist; `launch_app` is added
  here too, so a phrasing the fast-path regex doesn't catch ("I need to check something in
  WhatsApp, open it") still benefits from the deterministic launch instead of the slow
  Win+type+Enter sequence the desktop prompt currently documents.
- `src/main/sandbox/risk-classifier.ts` `BARE_LAUNCH` — already treats a bare `Start-Process
  <name>` as approval-free; `launch_app` gets the equivalent always-allow treatment for the
  same reason (opening an installed app is not destructive), see decision 4.

## Decisions / assumptions (flagging for approval)

1. **Detection is a cheap deterministic match on the raw user text, run BEFORE the supervisor
   ever sees the request — not an LLM call.** A regex family matches `^(open|launch|start|run)
   \s+(the\s+)?(.+)$` (and a couple of common variants: "can you open X", "open up X"), case
   insensitive, on the *whole trimmed message* only — a multi-sentence message ("open notepad
   and then also check my email") intentionally does NOT match, because that's a multi-step
   request the supervisor genuinely needs to plan. This keeps false-positive risk low: the fast
   path only fires for the narrow, unambiguous "open/start/launch \<app\>, nothing else" shape.
2. **App-name resolution happens inside the MCP server (`launch_app` tool), not in the
   fast-path matcher.** The matcher extracts a candidate string ("whatsapp") and hands it to
   the tool; the tool does the real work: `Get-StartApps` (cached 5 minutes, same TTL pattern
   as `getDisplaysCached`), then scores candidates by (a) exact case-insensitive name match, (b)
   name starts-with, (c) name contains, (d) token-overlap — dependency-free, no fuzzy-matching
   library. A confident single top match launches; anything ambiguous (two apps score equally,
   or nothing scores above a minimum threshold) returns `{ launched: false, candidates: [...] }`
   instead of guessing.
3. **The fast path only proceeds on a confident resolution; anything else falls through to the
   normal supervisor loop with the resolution already known.** If `launch_app` comes back
   ambiguous or not-found, the fast path does NOT error out to the user — it hands the same
   request to the graph as a normal turn, so the supervisor can ask a clarifying question or
   try another approach. The user never sees "fast path failed"; they see the same agent they'd
   get without this feature, just slightly slower. This is the safety net that makes an
   imperfect matcher/resolver acceptable to ship.
4. **`launch_app` is approval-free (like `BARE_LAUNCH` today), because starting an installed
   program is not destructive** — same reasoning already encoded in the risk classifier for
   `Start-Process notepad`. It is still fully traced (`tool_execution_start/end` with `intent`
   set from the matched request) and still goes through the resource lock.
5. **Resource key: `app-launch:<resolved-app-id>`, not `native-input`.** Launching a program
   doesn't move the mouse or send keystrokes, so serializing it against `click`/`type_text`
   would be an unnecessary bottleneck (worked-example reasoning from section 11: lock keys come
   from what a call actually touches, never its "kind"). Two different apps launch concurrently;
   two requests for the *same* app in flight serialize so they can't double-launch it.
6. **Post-launch verification is a single bounded wait, not a full desktop-subagent turn.**
   After a successful `Start-Process`-equivalent launch, `launch_app` polls (up to 4s, 250ms
   interval) for a foreground/visible top-level window whose process matches the launched
   AppID's underlying process — using the UIA worker's existing `element_at_point`/window
   enumeration plumbing, not a new mechanism — and reports `{ launched: true, confirmed:
   boolean }`. `confirmed: false` (app is slow to open, or opened behind another window) still
   reports success-with-caveat to the user rather than failing the whole turn; it does not
   retry (retrying a launch is how you get two copies of an app open).
7. **Registry shape, for future fast paths (not built now, just not precluded):**
   `FastPath { name, match(text) => MatchResult | null, run(match, ctx) => Promise<TurnOutcome |
   null> }`, where returning `null` from `run` (not just from `match`) is exactly the "fall
   through to the normal agent" signal from decision 3. Only the "open app" entry ships in this
   stage — this decision just keeps the door open the way section 14 asks, without speculative
   extra scope.

## Files to touch
Create:
- `src/mcp-server/tools/apps-launch.ts` — `launch_app` tool: `Get-StartApps` cache, name
  scoring, `explorer.exe shell:AppsFolder\<AppID>` launch, bounded post-launch confirmation.
- `src/main/agent/fast-paths/registry.ts` — the `FastPath` type + `registerFastPath`/
  `matchFastPaths`, mirroring `subagent-registry.ts`'s shape.
- `src/main/agent/fast-paths/open-app.ts` — the regex matcher + `run()` that calls `launch_app`
  through the turn's `ToolExecutor` (so it's risk-classified, locked, and traced normally) and
  returns a `TurnOutcome` on a confident launch, or `null` to fall through.
- `src/main/agent/fast-paths/index.ts` — registers the built-in fast paths (mirrors
  `subagents/index.ts`).
- Tests: `apps-launch.test.ts` (server-side: scoring against a fixture app list, ambiguous vs.
  confident resolution — no real launches in the automated test), `open-app.test.ts` (matcher:
  positive/negative phrasings, especially that multi-clause messages do NOT match).

Modify:
- `agent-runner.ts` `AgentRunner.run()` — try `matchFastPaths(userText)` first; on a non-null
  outcome, skip `this.graph.invoke(...)` entirely for this turn.
- `tools/resource-resolvers.ts` — `launch_app` → `[\`app-launch:${args.app_name}\`]`.
- `subagents/desktop-subagent.ts` — add `launch_app` to its tool allowlist.
- `sandbox/risk-classifier.ts` — `launch_app` added to the always-allow set alongside the
  existing `BARE_LAUNCH` reasoning (one line, same justification).
- `agent/prompts/desktop.ts` — mention `launch_app` as the preferred way to open an app
  (replacing the current "Win, type name, Enter" as the *primary* method; that sequence stays
  documented as a fallback for anything not in the Start menu).

## Safety implications
- No new destructive capability — `launch_app` can only start a program already registered in
  the user's own Start menu; it cannot pass arguments, open arbitrary paths, or elevate.
- Because it's approval-free, the matcher's false-positive bar matters: decision 1's "whole
  message must be exactly an open-request" rule is what keeps this from ever firing on a
  buried instruction inside a longer message (e.g. text pasted from a webpage that happens to
  contain the word "open").
- Fully traced like any other tool call — a fast-path launch is visually identical in
  `TracePanel` to an agent-dispatched one, so "why did this open?" is always answerable from
  the trace.

## Acceptance criteria
1. "open whatsapp" (or "launch whatsapp", "start whatsapp", "can you open whatsapp") → WhatsApp
   opens in well under 2s total, one traced `launch_app` call, zero LLM calls.
2. "open notepad and type hello world" → does NOT fast-path (multi-clause); goes through the
   normal supervisor/desktop flow as it did in Stage 3.
3. "open xyzxyz-not-a-real-app" → falls through to the normal agent turn, which reports it
   can't find the app — never a bare tool error surfaced as the final answer.
4. Two fast-path launches for two different apps in the same window of time both start without
   waiting on each other; two requests for the same app serialize (second one no-ops/confirms
   the first is already open rather than double-launching).
5. `bun test`: scoring/ambiguity cases, matcher positive/negative cases including the
   multi-clause negative, and the resource-resolver key.
6. `bun run typecheck` clean.

## Manual test steps
1. `bun run dev`. Ask "open calculator" — time from send to window appearing should visibly beat
   a normal agent turn (compare against Stage 3's "open Notepad" run, ~35s+).
2. Check `TracePanel`: one `launch_app` row, no supervisor planning rounds, no LLM calls logged.
3. Ask "open definitelynotarealapp123" — confirm it falls through and the agent's normal
   not-found handling kicks in (a real supervisor turn, LLM calls visible).
4. Ask "open notepad and save a file called test.txt on the desktop" — confirm this does NOT
   fast-path and runs the full agent loop, so multi-step requests are never truncated to "just
   open it".
