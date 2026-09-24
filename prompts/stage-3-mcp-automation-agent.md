# Stage 3 — MCP desktop/browser automation + PowerShell, agent loop, full tracing

## Goal
Port the `Mcpgui` reference project (`C:\Users\navas\Downloads\vibecode\ai project\Mcpgui`) into
this repo as a properly modularized MCP server, **keeping all 38 of its tools with the same
behavior**. Add one new tool, `run_powershell`. Then connect it to the app:

1. **MCP server** (`src/mcp-server/`): a separate Bun process that speaks MCP over stdio. It
   stays usable from VS Code / Claude Code, the same way the original is.
2. **MCP client** (`src/main/mcp/`): owns that process from the Electron main process. It
   connects, restarts after a crash, lists tools, runs tool calls with timeouts and
   cancellation, and passes the server's logs into the trace.
3. **Agent** (`src/main/agent/`): a LangGraph.js supervisor with three subagents (desktop,
   browser, shell). It runs on `agnes-3-flash` with professional per-role system prompts.
4. **Safety pipeline** (`src/main/sandbox/`, `src/main/tools/`): every tool call from every
   subagent goes through resource resolution, then the risk classifier, then the approval gate
   (if flagged), then the resource lock, then MCP. This is AGENTS.md sections 3 and 11.
5. **Tracing, Claude Code-style**: every model request, supervisor routing decision, tool call
   (args, risk verdict, approval, lock wait, duration, result, image) and subagent handoff is
   saved to SQLite, streamed to a new `TracePanel`, and logged to the console.

## Layers touched
New: `src/mcp-server/**`, `src/main/mcp/`, `src/main/tools/`, `src/main/sandbox/`
(`risk-classifier`, `approval-gate`, `resource-lock-manager`), `src/main/perception/redactor.ts`,
`src/main/agent/**` (runner, registry, subagents, prompts, LLM client, trace),
`src/renderer/TracePanel.tsx`, `src/renderer/ApprovalDialog.tsx`.
Modified: `session-manager.ts`, `database.ts`, `index.ts`, preload + `vite-env.d.ts`, `App.tsx`,
`package.json`, `electron-builder.json5`, tsconfigs, `.env(.example)`, `config-store.ts`.

## Docs consulted
- AGENTS.md sections 3 (safety, non-negotiable), 5 (layout), 6 (lifecycle), 7 (Tool call / risk
  rule / IPC contracts), 10 (supervisor hub-and-spoke, bounded loops), 11 (resource-keyed
  locks, worked examples), 12 (pitfalls), 13 (required checks).
- MCP TypeScript SDK 1.30 (the reference project's pinned version): `McpServer.registerTool`,
  `StdioServerTransport`, `Client` + `StdioClientTransport`, logging capability.
- LangGraph.js: `StateGraph`, conditional edges, `Send` for parallel fan-out.
- Chrome DevTools Protocol (the reference project's comments on why Chrome 136+ needs a separate
  profile).
- Memory: **Windows-only scope**. No `process.platform` branches, no mac modifier aliases, no
  Lima.

## Code inspected
- **Reference `src/server.ts`, all 3,235 lines, read in full.** Tool inventory, with each tool's
  new home, is in the parity table below. `.vscode/mcp.json` runs it as stdio (`bun run
  src/server.ts`). The user's existing learned data is in `~/.mcpgui/apps/` (5 apps: excalidraw,
  google-chrome, microsoft-word, whatsapp, windows-settings).
- Ours: `session-manager.ts` (`continueSession` only appends a message; no agent yet),
  `database.ts` (`tool_executions` table exists but nothing writes to it), `preflight.ts` (no
  checks yet), `workspace-path-constraints.ts` (throws until "Stage 3"), `title-generator.ts`
  (isolated model; not touched), `load-env.ts`, `electron-builder.json5` (no extraResources),
  `useIPC.ts`, `App.tsx`.
- **Live probes against `router.bynara.id` with `agnes-3-flash`:** native tool calling works
  (`finish_reason: "tool_calls"`, well-formed `tool_calls[]`), and image input works (a
  `data:image/png` content part was described correctly). So the agent uses real function
  calling and real vision; no JSON-in-text workaround is needed.

## Decisions / assumptions (flagged for approval)

### Architecture
1. **The MCP server stays a separate Bun process.** `bun:ffi` (user32/gdi32/kernel32/shcore
   bindings, with no native npm modules) only exists under Bun. It cannot load inside Electron's
   Node. Keeping it out-of-process also matches what MCP is for, and a crash in native input
   code can't take down the app.
   - Dev: the client spawns `bun run src/mcp-server/index.ts`.
   - Prod: `bun build --compile` produces `mcp-desktop.exe` (a new `build:mcp` script). It ships
     through electron-builder `extraResources`, so the packaged app doesn't need Bun installed.
     `bun:ffi` works in compiled executables.
2. **LangGraph.js supervisor with three subagents, per AGENTS.md section 10.** There are
   `desktop`, `browser` and `shell` nodes, with a conditional edge that always returns to the
   supervisor and never goes from one subagent to another. Each subagent only sees the tools
   for its own domain: desktop gets 18, browser gets 17, shell gets 1. That split matters for
   accuracy: putting all 39 schemas into one flash-model prompt lowers tool-selection accuracy,
   while a focused prompt with a focused toolset raises it. The supervisor keeps an explicit
   checklist in graph state. Independent checklist items fan out with `Send`, and the lock
   manager decides whether they actually run in parallel.
   - `echo` stays on the server (so nothing is lost for external clients) but isn't given to any
     subagent. `wait` goes to both the desktop and browser subagents.
   - AGENTS.md section 5 names `code-subagent.ts` (file operations). File operations run through
     `run_powershell` here, so the file is `shell-subagent.ts`. A dedicated file-tool code
     subagent can be added later through the registry without touching dispatch.
3. **The model client is our own thin OpenAI-compatible `fetch` client
   (`agent/llm-client.ts`), not `@langchain/openai`.** Full control over tracing every request
   is the requirement: model, message count, token usage, latency, finish reason, and retries.
   LangGraph nodes are plain async functions, so only `@langchain/langgraph` and its
   `@langchain/core` peer are added. Retries: at most 2, only on 429/5xx/network errors, with
   backoff. Each request has a 60s timeout and honors the turn's `AbortSignal`.
4. **Model config is separate from title generation.** New variables `AGENT_BASE_URL`,
   `AGENT_API_KEY` and `AGENT_MODEL=agnes-3-flash` (same URL and key you gave). The
   `TITLE_GEN_*` variables and `nemotron-3-ultra-free` are untouched (decision 8 of
   `ai-title-generation.md`). `DEFAULT_CONFIG.defaultModel` becomes `agnes-3-flash`.
   Existing sessions still store `model: "claude-sonnet-5"`, a placeholder that nothing ever
   called. A one-time update rewrites that exact value to `agnes-3-flash`, and the runner then
   uses `session.model`, per the `Session` contract.

### Tool-call contract (AGENTS.md section 7)
5. **An `intent` parameter is added to every tool schema the model sees**, and stripped before
   the call is forwarded to MCP. It's a required, one-line description of what the call is for,
   like Claude Code's `description` on Bash. It becomes the trace row title and fills
   `restatedGoal`. `reasoningTrace` is the assistant text that came before the call. `resources`
   is computed from `args` by `tools/resource-resolvers.ts`.
   **`confidence` is deferred.** A flash model's own confidence number is noise, and using it to
   skip clarification would be the model vouching for itself. The field stays in the contract
   but isn't used for routing.

### Safety (AGENTS.md section 3)
6. **✅ Approved 2026-09-24 ("host + gate"): native execution runs on the host, not in a WSL2 VM.**
   `click`/`type_text`/`key_press`, CDP-driven Chrome, and `run_powershell` can't do their job
   from inside a VM, because they exist to act on *your* desktop. `vm-runner.ts` isn't built by
   this stage. Instead, the risk classifier plus the approval gate is the boundary:
   - `run_powershell` is **approval-required by default**. Only commands where *every*
     pipeline/chain segment matches a read-only allowlist skip approval: `Get-*`,
     `Test-Path`, `Resolve-Path`, `Select-String`, `Measure-Object`, `Format-*`/`Out-String`,
     `whoami`, `hostname`, `ipconfig`, `systeminfo`, and `dir`/`ls`/`cat`/`type` without
     redirection. Redirection (`>`), `-Verb RunAs`, `Invoke-Expression`/`iex`, encoded commands,
     and subexpressions (`$(…)`) always require approval.
   - Hard-flagged categories, per the section 7 rule shape:
     - `file-delete`: Remove-Item, rm, del, rmdir, Clear-Content.
     - `mass-modify`: wildcards combined with Move-/Rename-/Set-, `-Recurse`, reg add/delete,
       Set-ItemProperty on HKLM/HKCU, Stop-Process, Stop-Service, shutdown, Format-Volume,
       Set-ExecutionPolicy, bcdedit.
     - `network-egress`: iwr, irm, curl, wget, Invoke-WebRequest, Invoke-RestMethod,
       Start-BitsTransfer, `browser_set_file_input`.
     - `credential-entry`: `browser_type` into password or `autocomplete=*password*` fields;
       `type_text` while the focused UIA element has `IsPassword`.
     - `payment`: text that passes a Luhn check (13–19 digits) or looks like a CVV, typed into
       an element whose selector or name matches card/cvv/cvc/expiry.
   - `browser_evaluate` (arbitrary JS in the page) is approval-required. So is
     `clear_click_history`. Plain clicks, scrolls, screenshots and reads are allowed, because
     approving every click would make the agent unusable.
   - Rules match literal `args` only, never `reasoningTrace` or `intent`. That is tested with
     adversarial cases (decision 17).
7. **Approval gate.** It sends an `approval.request` event to the renderer's `ApprovalDialog`,
   showing tool, command/args, risk category, intent, and the subagent that asked. The call
   blocks until the user clicks Approve or Deny. If the user doesn't answer within 5 minutes,
   or cancels the turn, the call is **denied**. A denial goes back to the model as a tool result
   ("User denied: …"), so it can plan around it. It never retries the same call silently.
8. **✅ Approved 2026-09-24 ("allow, mask passwords"): screenshots go to the cloud model with only password-field masking.**
   AGENTS.md section 3 says no raw screenshot leaves the device before redaction. What v1 of
   `perception/redactor.ts` actually does:
   - It is the enforcement point in main. It refuses to forward any image block that doesn't
     carry the server's `redaction` record.
   - The server masks password fields before encoding. For desktop captures it uses UIA
     `IsPassword` rects from the existing find-element worker. For browser captures it uses
     `input[type=password]` rects via CDP. The masking is a solid fill at those rects.
   - **General PII/OCR redaction is not done.** Chat text, emails and documents on screen *will*
     be visible to the model provider. A config flag, `allowScreenshotsToModel` (default
     `true`), turns vision off entirely if you'd rather not send any. If it's `false`, image
     results are replaced with "[screenshot withheld by policy]".
9. **Resource locks, global across sessions, per AGENTS.md section 11:**
   - `native-input`: click, type_text, key_press, scroll, drag, move_mouse.
   - `browser-context:<tab_id|active>`: every browser_* tool that targets a tab.
   - `shell`: run_powershell. What an arbitrary command touches can't be known, so shell
     commands serialize with each other only.
   - `file:<path>`: screenshot's `output_path`.
   - `app-memory`: init_app, clear/get_click_history.
   - Screenshots and read-only queries have no lock.
   Lock waits are traced. Tests cover the section 13 same-kind and cross-kind pairs.
10. **Bounded loops.** A subagent's tool loop is capped at `retryPolicy.maxLoopIterations`
    (default 25) model steps per dispatch. Supervisor dispatches are capped at the same number
    per turn, and a failed subagent is re-dispatched at most `retryPolicy.maxRetries` (3) times.
    Hitting a cap ends the turn with a status report: what finished, what didn't, and why.
    Turns can be cancelled with a new `session.cancel` and a Stop button. Cancelling aborts the
    in-flight model request and any pending approval; an MCP call already running finishes, and
    nothing new starts after it.
11. **Outcome persistence.** `tool_executions` rows are written for every call (they're the
    "outcome written to memory" for now). A `memory-manager.ts` for recall and preferences is
    **deferred** because nothing reads it yet.

### Port fidelity and improvements
12. **Kept exactly (same code where it works):**
    - FFI tables and struct layouts (INPUT, MONITORINFOEXW, BITMAPINFOHEADER).
    - DPI-aware display enumeration with the 5s cache.
    - The `auto`/`absolute`/`normalized`/`screen` coordinate model.
    - Label-based click memory stored as normalized coordinates with verified/use counts.
    - `guide.md` per app.
    - The persistent PowerShell line-worker protocol, and the UIA and Core Audio/WMI scripts
      (moved to real `.ps1` files imported as text).
    - The CDP client: dedicated persistent profile, flat sessions, event waiters, network-idle
      tracking, dialog tracking.
    - All DOM expressions, including the highlight/extract feature.
    - The screenshot cache with invalidation after input.
    - Every tool name, parameter name and default. That keeps `.vscode/mcp.json` users and the
      existing `~/.mcpgui` data compatible.
13. **Fixed or improved:**
    - **PNG, not BMP.** A small encoder built on `node:zlib`, with no dependency. Screenshots
      become about 10–50× smaller, and they're a format vision APIs accept. Images are
      optionally downscaled to at most 1600px on the long edge. The result includes `width`,
      `height`, `scale` and the display origin, and prompts tell the model to click with
      **normalized 0–1000 coordinates** taken from screenshots. Those don't depend on
      resolution, so downscaling can't make clicks land in the wrong place.
    - The reference's startup `console.log` wrote to stdout, which is the JSON-RPC channel. It
      now writes to stderr.
    - `screenshot`'s default path was `./screenshot-*.bmp` in whatever the current directory
      was. It now goes to `<dataDir>/screenshots/`.
    - `browser_navigate` records the real final URL and title after redirects instead of the
      requested URL.
    - One `defineTool()` helper replaces about 38 copies of the same try/catch/isError
      boilerplate and the log wrapper. It adds timing, argument truncation, `notifications/
      message` logging, and a per-call `AbortSignal`.
    - `process.platform` checks and mac modifier aliases (`command`/`cmd`/`option`) are removed
      (Windows-only memory). `win`/`meta`, `ctrl`, `alt` and `shift` remain. This is a small
      behavior change: a caller passing `"cmd"` now gets an "unknown modifier" error.
14. **The data directory moves from `~/.mcpgui` to `<userData>/mcp-desktop/`,** passed to the
    server as `MCP_DATA_DIR`. On first run, if the new folder is empty and `~/.mcpgui/apps`
    exists, it's **copied, not moved**, so your 5 apps' learned click history carries over and
    the original project keeps working. If `MCP_DATA_DIR` is unset (running standalone from VS
    Code), the server falls back to `~/.mcpgui`, which is the original behavior.
15. **The new `run_powershell` tool** runs one fresh `powershell.exe -NoLogo -NoProfile
    -NonInteractive` per call, with UTF-8 output forced.
    - Arguments: `command`, `cwd` (default: the session workspace, or the user's home folder),
      and `timeout_ms` (default 60s, capped at 600s).
    - Returns stdout, stderr, exit code, duration and a `timed_out` flag. Output is capped at
      30k characters, with the middle cut out and marked.
    - On timeout the whole process tree is killed (`taskkill /T /F`).
    - A fresh process per call, rather than one persistent shell, means no leftover state, no
      output-framing races, and a timeout kill that's guaranteed to work. The working directory
      is passed explicitly on each call instead of carried over.

### Prompts
16. `agent/prompts/` holds the prompts: `shared.ts` (environment facts: Windows, displays, date,
    safety contract), `supervisor.ts`, `desktop.ts`, `browser.ts` and `shell.ts`. Each is a
    structured professional prompt covering role, scope, tool strategy, verification rules,
    failure/escalation rules, output format, and safety.
    - **Tool strategy for desktop** (the order the reference's own tool descriptions push
      toward): cached label from `get_click_history`, then `find_element` (UIA), then
      `screenshot_for_display` for vision, with normalized coordinates.
    - **Verify after state changes:** after an action that matters, re-check with UIA or a
      screenshot before reporting success.
    - **Browser strategy:** DOM tools before desktop tools. Use `browser_extract_highlighted`
      whenever extracted text will be quoted, and return claim objects `{ sourceUrl, claim,
      supportingText, citationMeta }`, not raw HTML (AGENTS.md section 10).
    - **Shell strategy:** prefer read-only inspection first, one purpose per command, never
      chain a destructive step behind a read, and explain side effects in `intent`.
    - The supervisor writes the checklist first, dispatches with a precise brief (goal, known
      context, done-criteria), checks each result against the checklist, and ends with a
      summary plus a suggested follow-up.

### Tracing
17. **`agent/trace.ts` is one emitter with three sinks:** SQLite (a new `trace_events` table),
    the renderer (IPC), and the console. Event types follow the section 7 vocabulary:
    - `agent_start`
    - `supervisor_decision` (checklist, chosen subagent(s), brief)
    - `llm_request` / `llm_response` (model, tokens, ms, finish reason, retry count)
    - `message_update` / `message_end`
    - `tool_execution_start` (intent, args, resources, risk verdict)
    - `approval_requested` / `approval_resolved`
    - `lock_wait`
    - `tool_execution_end` (ms, isError, result preview, image thumbnail reference)
    - `subagent_end`
    - `mcp_log` (the server's `notifications/message` + stderr at debug level)
    - `agent_end`
    Each event carries `sessionId`, `turnId`, `parentId` (for nesting under a subagent step),
    `seq`, and `ts`.
18. **`TracePanel` is Claude Code-style.** Each tool call is one row: `● Desktop › click —
    "Open the File menu" (412ms)`, with a `⎿` result line underneath. There are status dots
    (running/ok/error/denied), expandable args and results, inline screenshot thumbnails, and
    supervisor decision rows. Rows are nested under their subagent step. Messages and trace
    events for a session are loaded from SQLite, so the trace survives a restart.

## Tool parity (all 38 reference tools plus 1 new)
| Reference tool(s) | New module |
|---|---|
| get_all_visited_apps, init_app, clear_click_history, get_click_history | `tools/apps.ts` (+ `app-memory/app-store.ts`) |
| click, scroll, drag, move_mouse, get_mouse_position | `tools/mouse.ts` |
| type_text, key_press | `tools/keyboard.ts` |
| get_displays, screenshot, screenshot_for_display | `tools/screen.ts` |
| find_element | `tools/element.ts` (+ `powershell/scripts/find-element.ps1`) |
| get_volume, set_volume, get_brightness, set_brightness | `tools/system.ts` (+ `system-control.ps1`) |
| echo, wait | `tools/misc.ts` |
| browser_connect, list_tabs, new_tab, activate_tab, close_tab, navigate | `tools/browser-tabs.ts` |
| browser_find, click, type, get_text, wait_for, set_file_input, handle_dialog | `tools/browser-dom.ts` |
| browser_extract_highlighted, clear_highlights, screenshot, evaluate | `tools/browser-page.ts` |
| **run_powershell (new)** | `tools/shell.ts` (+ `powershell/run-command.ts`) |

A test asserts the server lists exactly these 39 names.

## Files to touch
**Create: MCP server (`src/mcp-server/`, Bun, own `tsconfig.mcp.json`)**
- `index.ts` (bootstrap, registers tool modules, stdio transport)
- `core/define-tool.ts`, `core/result.ts`, `core/async.ts`, `core/paths.ts` (data dir, `~/.mcpgui` copy)
- `win32/ffi.ts`, `win32/input.ts`, `win32/displays.ts`, `win32/clipboard.ts`, `win32/capture.ts`, `win32/png.ts`
- `powershell/line-worker.ts`, `powershell/run-command.ts`, `powershell/scripts/find-element.ps1`, `powershell/scripts/system-control.ps1`
- `app-memory/app-store.ts`
- `browser/cdp-client.ts`, `browser/page-scripts.ts`
- `tools/*.ts` (the 10 modules in the parity table)
- `mcp-server.test.ts` (spawns the server, checks the 39 names, calls read-only tools:
  `get_displays`, `get_mouse_position`, `get_volume`, `run_powershell "Get-Date"`), `win32/png.test.ts`

**Create: main process**
- `mcp/mcp-client.ts` (spawn and connect, crash restart with backoff, `listTools`, `callTool` with timeout and abort, log forwarding)
- `mcp/tool-adapter.ts` (MCP JSON Schema to OpenAI function schema, plus `intent`; MCP content to model parts)
- `tools/tool-executor.ts` (the section 11 pipeline), `tools/resource-resolvers.ts`
- `sandbox/risk-classifier.ts` (+ `.test.ts` with adversarial cases), `sandbox/approval-gate.ts`, `sandbox/resource-lock-manager.ts` (+ `.test.ts`, concurrency)
- `perception/redactor.ts`
- `agent/llm-client.ts`, `agent/agent-runner.ts`, `agent/subagent-registry.ts`, `agent/subagent-loop.ts`, `agent/trace.ts`
- `agent/subagents/desktop-subagent.ts`, `browser-subagent.ts`, `shell-subagent.ts`
- `agent/prompts/shared.ts`, `supervisor.ts`, `desktop.ts`, `browser.ts`, `shell.ts`

**Create: renderer**
- `TracePanel.tsx`, `ApprovalDialog.tsx`, `hooks/useTrace.ts`

**Modify**
- `package.json`
  - Dependencies: `@modelcontextprotocol/sdk@^1.30`, `zod@^4`, `@langchain/langgraph`, `@langchain/core`.
  - Scripts: `mcp:dev`, `build:mcp`, and `build` running `build:mcp` first.
- `electron-builder.json5`: `extraResources` for `mcp-desktop.exe`.
- `tsconfig.json` (reference `tsconfig.mcp.json`), `tsconfig.node.json` (exclude `src/mcp-server`).
- `database.ts`: a `trace_events` table, plus these `tool_executions` columns: `turn_id`,
  `subagent`, `intent`, `risk_category`, `approval`, `duration_ms`, `is_error`.
- `session-manager.ts`: `startSession` warms the runner. `continueSession` appends the message,
  returns right away, and runs the turn in the background. `session.cancel` is added.
  `stopSession` tears down the runner.
- `index.ts`: start the MCP client, register `approval.respond` and `session.cancel`, add
  preflight checks.
- `preflight.ts`: real checks for Bun (dev) or `mcp-desktop.exe` (prod), `AGENT_API_KEY` being
  set, and Chrome being resolvable. These are the first real preflight checks.
- `src/preload/index.ts`, `vite-env.d.ts`, `types.ts`: trace and approval events, `respondApproval`, `cancelTurn`.
- `App.tsx`: render messages and `TracePanel` interleaved, `ApprovalDialog`, a Stop button
  while running.
- `config-store.ts`: `defaultModel: "agnes-3-flash"`, `allowScreenshotsToModel: true`.
- `.env` / `.env.example`: `AGENT_BASE_URL`, `AGENT_API_KEY`, `AGENT_MODEL`.

## Safety implications
- This is the first stage where the app **acts on the real machine**: mouse, keyboard, Chrome,
  and shell. Decisions 6–10 are the controls. The two ⚠ items (host execution and screenshot
  redaction scope) are the ones that need your explicit sign-off.
- Every call goes through `tool-executor`. Subagents never call MCP directly, and there are no
  edges between subagents. A test builds the graph and checks that every subagent's only
  outgoing edge is to the supervisor.
- External MCP clients (VS Code) that talk to the server directly skip our gate. That's the
  same as the original project today, and VS Code asks for its own confirmation. The server
  itself doesn't try to enforce policy.
- Secrets: `AGENT_API_KEY` is read from `.env` only, is never written to the trace (the LLM
  client strips `Authorization` from logged requests), and is never sent to the MCP server
  process's environment.

## Acceptance criteria
1. `bun test`: server parity (39 tools), read-only tool smoke tests, PNG encoder, risk classifier
   (including **100% catch** on the adversarial set: model-emitted `Remove-Item`,
   `iwr … | iex`, `reg delete`, password typing, card numbers, and destructive commands hidden
   behind `;`/`|`/`&&` after a harmless read), and lock manager concurrency (section 13 pairs).
   The graph edge test passes. The existing title-generator tests still pass.
2. `bun run typecheck` clean. `bun run build` (including `build:mcp` and electron-builder)
   succeeds.
3. In the running app: "open Notepad and type hello world". The trace shows the supervisor
   checklist and dispatch to desktop, then find_element or screenshot, click/type rows with
   intents and timings, then a verification screenshot, then `agent_end` with a summary. The
   assistant message is saved.
4. "Search Wikipedia for Kyoto and give me the first paragraph with its source". Dispatched to
   browser: the automation Chrome profile launches, it navigates, and the text is extracted
   with a highlight and returned as a claim object with the source URL.
5. "List the 5 largest files in my Downloads folder". Shell runs `Get-ChildItem …` with **no**
   approval prompt, because it's read-only. Then "delete the largest one": an approval dialog
   appears; **Deny** means the file is untouched and the agent reports the denial.
6. Stop mid-task: the run halts after the current call, and the trace shows a cancelled
   `agent_end`.
7. Restart the app: the session, its messages and its full trace reload.
8. Existing `~/.mcpgui` click history appears through `get_all_visited_apps` (copied into the
   new data folder), and `~/.mcpgui` itself is unchanged.

## Manual test steps
1. `bun install`, then `bun test`, `bun run typecheck`, `bun run dev`.
2. Check the startup console for preflight and MCP-client lines: `connected, 39 tools`.
3. Run acceptance items 3–6 in order, watching `TracePanel` fill in live.
4. Kill `bun.exe` (the MCP server) from Task Manager mid-idle. The next prompt should trigger
   an automatic reconnect, visible as a traced `mcp_log`/reconnect event.
5. Set `allowScreenshotsToModel: false` in `config.json`, restart, and ask something that needs
   vision. The trace should show images withheld and the agent falling back to UIA/DOM.
6. `bun run build` and run the packaged app from `release/`. The MCP server should start from
   `resources/mcp-desktop.exe` with no Bun on PATH (rename `bun.exe` temporarily to prove it).

## As built — deviations and findings (2026-09-25)
- **No `AGENT_MODEL` env var.** The model name has one source: `config.json` `defaultModel`
  (`agnes-3-flash`), copied onto each session. `.env` holds only `AGENT_BASE_URL` and `AGENT_API_KEY`.
  Stage 1's unused `claude-sonnet-5` placeholder is migrated in both config.json and existing sessions.
- `find-element.ps1` became `powershell/scripts/ui-automation.ps1`, with two extra actions
  (`focused_element`, `element_at_point`, `password_rects`). `find_element` gained optional `focused` and
  `at_point` params (additive, backward-compatible). The executor uses them to classify `type_text`
  (typing into a password field) and `click` (whether the element under the point is "Delete", "Pay now" or "Send").
  For `browser_click`/`browser_type` it reads the DOM target through `browser_find`. These observations
  come from the OS/DOM, never from the model.
- MCP server logs (`notifications/message` plus stderr) go to the main-process console, not the per-turn trace.
  They aren't tied to a turn, and every call is already traced by the executor.
- Dev-only `AGENT_DEBUG_CDP_PORT` env var exposes the renderer over CDP so the UI can be driven by script
  (never in packaged builds).
- **Observed in end-to-end runs:** `agnes-3-flash` emits one tool call per response, even when told to
  combine calls. Parallel `Send` fan-out from a single supervisor response therefore won't occur with this
  model (the graph supports it), and a simple task takes about 4 supervisor rounds.
- Classifier refinement after a live false positive: pure static calls on `[math]`/`[string]`/`[datetime]`/
  `[convert]`/`[regex]` and calculated-property hashtables count as read-only. This also closed a hole
  where `$x = <command>` bypassed the allowlist.
- Title generation (the separate feature) fixes found here: the timeout went from 8s to 20s, `max_tokens` went
  from 20 to 400 (nemotron is a reasoning model), and the request is framed as data. It had been answering
  a Wikipedia question instead of titling it.
