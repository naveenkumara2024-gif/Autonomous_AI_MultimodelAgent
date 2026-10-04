# Stage 6 — Fast app launch, taskbar-aware desktop control, and the action cache

Supersedes `stage-5-fast-path-automation.md`, which was planned but **never implemented** (no
`launch_app`, no `fast-paths/` exist in the tree). Everything Stage 5 decided still holds unless
revised below; this stage adds the taskbar tier, the action cache, and the bug fixes the traces
exposed.

## Goal
"open WhatsApp" should take well under 1 s with zero LLM calls. A repeated multi-step task
should replay from a verified cache instead of re-planning from scratch. Every call still goes
through the risk classifier / approval gate / resource locks, and anything the fast path or the
cache can't confirm falls back to the normal agent loop.

## Diagnosis: why "open WhatsApp" is slow (from the real traces in `agent.db`)

**Run A: "open whatsapp", 86 s, cancelled by the user, never opened**
| t | what happened |
|---|---|
| 0 → 5.3 s | supervisor round 1: `set_checklist` only (a wasted LLM round) |
| 5.3 → 13.6 s | supervisor round 2: `dispatch` → **shell** (routing bug #1) |
| 13.6 → 86 s | shell agent: 6 LLM steps (3.5–11.5 s each), each spawning a **fresh** `powershell.exe`, probing `Program Files` / `.lnk` paths. **5 approval prompts**, 3 of them triggered by a classifier bug (#3) on plain read-only `Test-Path` commands |

WhatsApp on this machine is a **Microsoft Store (MSIX) app**
(`5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App`), so no `Program Files` path or `.lnk` exists. The
shell agent's whole search strategy could never have succeeded.

**Run B: "try open whatsapp from search icon", 260 s, cancelled, never opened**
| t | what happened |
|---|---|
| 0 → 12.5 s | 2 supervisor rounds again |
| 25 s | `screenshot_for_display` → `GetDIBits failed` (intermittent capture bug #6) |
| 31 → 65 s | 3× `find_element` for the taskbar search box, **every one "not found" after the full 3 s timeout**, because `window_title` only matches the window *Name* and the taskbar's Name is empty (bug #4). It silently searched the foreground window instead |
| 52 s | `screenshot` with `output_path` → approval prompt for a file write nobody needed (#5) |
| 80–88 s | random `ctrl+d`, `win+d` presses (model flailing) |
| 94 → 240 s | vision loop: each step was 22–35 s of model latency on screenshots. 3 steps to click one box |

**Measured on this machine (read-only):**
- UIA scan of the taskbar (`Shell_TrayWnd`): **137 ms**. It returns 23 buttons *with AppIDs*,
  including `WhatsApp pinned | Appid: 5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App`, and running
  state (`Word - 1 running window`).
- `Shell.Application` → `shell:AppsFolder` enumeration: 248 apps in **682 ms** cold (it's
  `Get-StartApps` in 1225 ms). Warm (cached in the persistent worker) it's 0 ms.
- Both "WhatsApp" and "WhatsApp Web" (a Chrome PWA) exist. The resolver must prefer the exact
  name.

### Root causes (numbered, referenced below)
1. **Routing:** `prompts/supervisor.ts:21` sends "launching apps by name → **shell**".
2. **No launch primitive:** Stage 5's `launch_app` + fast path was never built. Every "open X"
   pays at least 4 LLM round-trips (~6–12 s each on `agnes-3-flash`).
3. **Classifier false positives on read-only commands:** `commandSegments()` splits on `(`/`)`
   even inside quoted strings, so `Test-Path 'C:\Program Files (x86)\X'` yields a segment
   `x86)\X'` that is "not on the allowlist". `foreach`/`@(` language keywords and the read-only
   `Get-AppxPackage` / `Get-StartApps` are flagged too.
4. **`find_element` can't target the taskbar and fails slowly:** it matches `window_title`
   against Name only. An unmatched title silently falls back to the foreground window, then
   polls the full 3 s timeout.
5. **Prompt gaps:** the desktop prompt says "Win, type, Enter" as the *primary* open method,
   doesn't know the taskbar exists, and doesn't forbid `screenshot(output_path)`.
6. **`capture.ts` GetDIBits** fails intermittently on the first call. The immediate retry
   succeeded.
7. **Supervisor always spends a separate round on `set_checklist`** even though the prompt says
   to dispatch in the same response.

## Layers touched
MCP server (`tools/`, `powershell/scripts/ui-automation.ps1`, `win32/capture.ts`,
`app-memory/`), main-process agent (`agent-runner.ts`, new `fast-paths/`, prompts), new
`memory/action-cache.ts` + `db/` table, `sandbox/risk-classifier.ts`,
`tools/resource-resolvers.ts`.

## Docs consulted
AGENTS.md §3 (every call classified; loops bounded), §7 (`resources` from args), §10
(hub-and-spoke; a fast path/replay is a *routing* shortcut, never a safety shortcut), §11 (lock
keys from what a call touches), §14 (registry-driven). Stage 5 prompt. Windows UI Automation
(`InvokePattern`, `ClassNameProperty`), `shell:AppsFolder\<AppUserModelID>` activation (Stage 5
verified that it launches both UWP and Win32 apps).

## Code inspected
`agent-runner.ts`, `subagent-loop.ts`, `tool-executor.ts`, `llm-client.ts`, `prompts/*`,
`subagents/desktop-subagent.ts`, `risk-classifier.ts`, `mcp-server/tools/{apps,element}.ts`,
`app-memory/app-store.ts`, `powershell/{run-command,workers}.ts`, `ui-automation.ps1`,
`win32/capture.ts`, `db/database.ts`, and the `trace_events` rows for both runs above.

## Design

### A. `launch_app` MCP tool (in the warm UIA worker, never a fresh `powershell.exe`)
Input `{ app_name }`. Resolution ladder, stopping at the first confident hit:

| Tier | Source | Cost | Notes |
|---|---|---|---|
| 0 | **App-resolution cache** (see C) | ~0 ms | verified before use, see C |
| 1 | **Taskbar** UIA scan (`Shell_TrayWnd` buttons, `Appid:` automation ids) | ~140 ms | pinned + running apps; also tells us "already running" |
| 2 | **Start-apps index** (`shell:AppsFolder` COM, cached in-worker, refreshed at most every 5 min or on a miss) | 680 ms cold / 0 warm | covers all 248 Start-registered apps, UWP and Win32 |
| — | nothing confident | — | `{ launched:false, candidates:[…] }` → fall through to the agent |

Scoring: exact case-insensitive name > starts-with > whole-word contains > token overlap. A tie
means ambiguous and returns candidates instead of guessing ("whatsapp" → "WhatsApp" beats
"WhatsApp Web" on exactness, so it isn't ambiguous).

Action once resolved:
- **Already the foreground window** → no-op, `{ launched:false, already_open:true }`. A taskbar
  click would *minimize* it, so this check matters.
- **Running, one window, not foreground** → `InvokePattern` on its taskbar button (activates
  it; no mouse movement, no keystrokes).
- **Running, several windows** → report `already_open` with the count. Don't guess which one.
- **Not running** → `InvokePattern` on the pinned taskbar button if tier 1 hit, else
  `explorer.exe shell:AppsFolder\<AppID>` (spawned directly from Bun).
- **Confirm:** poll the taskbar scan (≤ 4 s, 200 ms interval) until that AppID's button reports
  a running window. This works identically for UWP and Win32, with no process-name guessing.
  Returns `{ launched, confirmed, app_id, display_name, tier, ms }`. Never re-launches on
  `confirmed:false` (that's how you get two copies).

Resources: `app-launch:<normalized app_name>`, not `native-input`. `InvokePattern` and
`explorer.exe` send no input events (§11). Risk: always-allow, same reasoning as the existing
`BARE_LAUNCH` rule. It can only start something already registered in the user's Start menu or
taskbar, with no arguments or paths.

### B. Fast path (Stage 5 decisions 1, 3, 7, unchanged)
`src/main/agent/fast-paths/` is a registry checked in `AgentRunner.run()` before
`graph.invoke`. The first entry is `open-app`: a whole-message match for
`(open|launch|start|run) [the] X` ("can you open X", "open up X"). Multi-clause messages never
match. It calls `launch_app` **through the turn's `ToolExecutor`**, so it is classified, locked,
and traced like any other call. On `launched:true` or `already_open` it ends the turn with a
one-line summary. Otherwise it returns `null` and the normal agent runs.

### C. Action cache (two levels)

**C1. App-resolution cache (MCP server, `app-memory/launch-cache.json` in `DATA_DIR`).**
`query → { app_id, display_name, tier, hits, last_ok_at, last_ms }`. Written after every
*confirmed* launch.
- **On a hit, verify before trusting:** the AppID must still be in the taskbar scan or the warm
  index. If the index is cold, trust the cache and let post-launch confirmation be the check.
- **Invalidate** the entry on "not found" or `confirmed:false`, then run the full ladder once.
  An uninstalled or renamed app self-heals.

**C2. Task-recipe cache (main process, new SQLite table `action_recipes`).**
- **Recorded:** after a turn ends with status `done` and **no** tool call in it was
  denied/errored, store the ordered state-changing calls (`key_press`, `type_text`, `click`,
  `launch_app`, `browser_*` actions, allow-classified `run_powershell`). Screenshots are dropped.
  - A **click is only cacheable if it's anchored**: it came from a `find_element` result (we
    store that query, not the coordinates) or from a click-history label with `verified_count ≥
    1`.
  - A recipe with any unanchored (pure vision-coordinate) click is **not cached**. Replaying raw
    pixel coordinates against a changed screen is how you click the wrong thing.
  - Key: the normalized request text (lowercase, trimmed, whitespace/punctuation-collapsed),
    exact match only. No fuzzy or semantic matching in v1.
- **Replay:** checked after fast paths, before `graph.invoke`. Each step runs through
  `ToolExecutor`, so the classifier and approval gate apply exactly as in a live run. Anchored
  clicks re-run their `find_element` first and click the *fresh* center.
  - **Any step failing** (element not found, tool error, denial) aborts the replay, increments
    `failures`, and hands the turn to the full agent with a note of what already ran so it
    doesn't redo it.
  - Two consecutive failures evict the recipe. Success bumps `successes` / `avg_ms`.
- **Traced:** `cache_hit` / `cache_miss` / `replay_step` / `replay_aborted` events. `TracePanel`
  shows "replayed from cache (N steps)" so the user always knows why something ran without the
  model.
- A setting `actionCache.enabled` (default on) plus a "clear cache" action. Recipes are keyed
  per user, not per session, because the whole point is to help across sessions.

### D. Bug fixes
- **#1** `supervisor.ts`: opening or switching to an app → **desktop** (`launch_app`). The shell
  role becomes files, system info, and processes only.
- **#3** `risk-classifier.ts`:
  - Make `commandSegments()` quote-aware so `'…(x86)…'` doesn't split.
  - Treat `foreach`/`for`/`if`/`elseif`/`else`/`while` heads and a bare `@` array-literal head
    as non-commands. Their bodies are still segmented and checked individually, and
    `POWERSHELL_RULES` still scan the whole command.
  - Add `get-startapps` and `get-appxpackage` to `READ_ONLY_COMMANDS`.
  - New tests: each false positive from Run A now allows, and each existing block test still
    blocks.
- **#4** `find_element`:
  - `window_title` also matches `ClassName`, and the alias `"taskbar"` resolves to
    `Shell_TrayWnd`.
  - An explicit `window_title` that matches nothing returns immediately:
    `found:false, error:"no window matching …", open_windows:[top 15 titles]`. No more silent
    fallback to the foreground window and no 3 s poll.
- **#5** `prompts/desktop.ts`:
  - `launch_app` is the primary way to open or switch to an app. "Win, type, Enter" stays as the
    fallback.
  - Document the taskbar recipe (`find_element window_title:"taskbar" automation_id:"SearchButton"`
    / `"StartButton"`, pinned apps by name) for when the user explicitly asks for the search box.
  - Never pass `screenshot(output_path)` unless the brief asks for a saved file.
  - Add `launch_app` to the desktop allowlist.
- **#6** `capture.ts`: one immediate retry of `BitBlt`/`GetDIBits` on failure before throwing.
- **#7** `set_checklist` accepts an optional `dispatches` array (same shape as `dispatch`), so
  planning and the first dispatch are **one** LLM round. The existing separate `dispatch` tool
  stays. This saves ~5–8 s on every non-fast-path turn.

## Files
**Create:**
- `src/mcp-server/tools/apps-launch.ts`
- `src/mcp-server/app-memory/launch-cache.ts`
- `src/main/agent/fast-paths/{registry,open-app,index}.ts`
- `src/main/memory/action-cache.ts`
- Tests: `apps-launch.test.ts` (scoring/ambiguity against a fixture list),
  `launch-cache.test.ts`, `open-app.test.ts` (positive/negative phrasings incl. multi-clause),
  `action-cache.test.ts` (record rules, unanchored-click rejection, replay abort + eviction).

**Modify:**
- `ui-automation.ps1` (actions `taskbar_apps`, `start_apps`, `invoke_taskbar`; class-name
  window matching; immediate not-found)
- `mcp-server/tools/element.ts`, `mcp-server/index.ts`, `win32/capture.ts`
- `main/agent/agent-runner.ts`, `prompts/{supervisor,desktop,shell}.ts`,
  `subagents/desktop-subagent.ts`
- `sandbox/risk-classifier.ts` (+ test), `tools/resource-resolvers.ts`
- `db/database.ts` (table `action_recipes`), `config/config-store.ts` (the toggle), and a trace
  row style for cache events in `TracePanel.tsx`

## Safety implications
- **Nothing new bypasses the gate.** The fast path and cache replay are routing shortcuts; every
  replayed or fast-path call goes through `ToolExecutor` (classifier → approval → lock → redactor
  → trace). A cached recipe that includes a "Send" click still prompts for approval every
  replay.
- **`launch_app` is approval-free,** but it can only activate an AppID already in the user's
  Start menu or taskbar. No args, paths, or elevation.
- **Classifier loosening is narrow:** quoted literals no longer split segments. `$(` is still
  forbidden anywhere, including inside double quotes, and every destructive rule still scans the
  full command text. The new tests assert both directions.
- **Replaying pixel coordinates is refused by design** (anchored clicks only), and any
  verification failure aborts to the live agent.
- **Nothing sensitive is stored:** recipes hold tool args as sent. `type_text` steps whose
  observed focused field was a password/sensitive field make the recipe **non-cacheable**, so
  secrets are never persisted.

## Acceptance criteria
1. "open whatsapp": WhatsApp in the foreground, **0 LLM calls**, one `launch_app` row, tool time
   < 500 ms warm (tier 0/1). Measured and reported from the trace.
2. "open whatsapp" while it's already in front → "already open", nothing minimized.
3. "open calculator" (not pinned) → tier 2 launch, confirmed.
4. "open xyzxyz" → falls through to the agent, which reports not found. "open notepad and type
   hi" → no fast path.
5. Uninstalled or renamed cached app → the cache entry is invalidated and re-resolved, with no
   user-visible error when the app still exists under a new name.
6. A repeated multi-step desktop task (e.g. "open notepad and type hello") replays from cache
   the second time with 0 LLM calls. Moving the Notepad window between runs still works (fresh
   `find_element`). Closing a needed dialog mid-replay aborts to the live agent.
7. Run A's commands (`Test-Path '…(x86)…'`, `foreach` over paths, `Get-AppxPackage`) classify
   as `allow`. All existing classifier block tests still pass.
8. `find_element window_title:"taskbar" automation_id:"SearchButton"` finds the search button
   in < 300 ms. A bad title returns immediately with `open_windows`.
9. `bun test`, `bun run typecheck`, and the concurrency tests (two `launch_app` for different
   apps run concurrently; the same app serializes) all pass. Electron build runs.

## Manual test steps
1. `bun run dev`. Send "open whatsapp" with WhatsApp closed. Check it opens and read the trace
   timings.
2. Send it again with WhatsApp in front (→ already open), then with it minimized (→ restored).
3. "open calculator", then "open definitelynotarealapp123".
4. "open notepad and type hello world" twice. The second run should show "replayed from cache".
5. "try open whatsapp from search icon": the agent should use `find_element` on the taskbar
   `SearchButton`, not a vision loop.
6. Settings → disable the action cache → step 4 goes back to the live agent.

## As built: changes to the plan found during implementation
- **Taskbar tier demoted.** This machine has taskbar auto-hide on (`ABM_GETSTATE=1`). While the
  taskbar is hidden, Windows removes its XAML content from the UIA tree, so it reports 0
  buttons. That also explains why the agent's taskbar clicks missed in Run B. The order is now
  cache → Start-menu index (warm, reliable) → taskbar (only for apps that are pinned but not in
  the Start menu). Pinned apps launch via `shell:AppsFolder` just as fast.
- **"Running?" is detected from windows, not the taskbar.** Top-level windows are matched to
  the AppID three ways:
  - the window's own AUMID (UWP frames such as Calculator);
  - the *process's* AUMID via `GetApplicationUserModelId` (packaged WinUI 3 apps: WhatsApp has
    no window-level AUMID);
  - the exe path from the Start-menu shortcut's `System.Link.TargetParsingPath` (Win32 apps:
    VS Code, Word, Chrome).
- **Focus switching** needs `AttachThreadInput` to beat the foreground lock (WinUI 3 windows
  refuse a plain `SetForegroundWindow`). Activation is also applied asynchronously, so the
  result is polled for ≤300 ms before reporting.
- **Resources: `launch_app` also holds `native-input`** (revises decision 5 above). A launch or
  switch moves keyboard focus, so a concurrent `type_text` could land in the wrong app. Two
  launches of different apps therefore serialize briefly, and a launch still runs in parallel
  with browser/shell/file work.
- **#6 capture fix:** `captureWithRetry` already retried 5×, and all 5 failed in the trace. The
  real fix replaces `CreateCompatibleBitmap` + `GetDIBits` with a `CreateDIBSection` that
  `BitBlt` writes into directly. This also fixed the previously flaky
  `screenshot_for_display` test.
- **Classifier:** the `foreach` keyword skip only applies to a *bare* keyword segment.
  `gci | foreach Delete` (ForEach-Object calling `.Delete()`) still blocks, with an adversarial
  test for it.
- **Recipe safety additions:**
  - context-dependent requests ("do it again", "close that") and requests under 3 words are
    never cached;
  - turns that read data (`run_powershell`, page text) aren't cached, because their answer
    depended on that data;
  - a launch that found nothing isn't a step.
- **No settings UI exists yet:** the toggle is `actionCacheEnabled` in `config.json`, plus an
  `actionCache.clear` IPC handler for a future settings screen.

**Measured in the real app** (dev build, driven over CDP; model `agnes-3-flash`):
| request | before | after |
|---|---|---|
| "open whatsapp" (closed) | 86 s, never opened | 3.1 s first-after-start, ~0.6 s warm, 0 model calls |
| "open calculator" (open, in background) | — | 92 ms, 0 model calls |
| "open notepad and type …" (1st, model) | — | 114.8 s, 9 model calls; desktop used `launch_app` (1.1 s) |
| same request repeated | — | **1.1 s, 0 model calls** (recipe replay) |

## Open assumptions (flag if wrong)
- **Model latency (6–35 s per call on `agnes-3-flash`) dominates everything that isn't a fast
  path or replay.** This stage removes LLM calls rather than speeding them up. A faster model
  for the desktop subagent is a separate config decision.
- **Running-but-unpinned apps are assumed to expose the same `Appid:` automation id on their
  taskbar button.** Pinned ones do (measured). This gets verified in testing. If not, tier 2
  plus a foreground-window check covers it.
- **Recipe matching is exact-text only in v1.** Parameterized recipes ("open X" for any X) are
  what fast paths are for.
