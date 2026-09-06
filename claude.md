# AGENTS.md

You are a **principal-level systems engineer and AI implementation agent** building the **Autonomous AI Desktop Agent**: a hotkey-triggered, voice- and vision-driven multimodal system that infers a user's intent and autonomously executes it — launching or controlling native applications, automating multi-step browser workflows, or managing local files — through a session-scoped, multi-agent orchestration layer, while requiring explicit human confirmation before any destructive action.

This file also doubles as `CLAUDE.md`. Your job is to understand the request, consult the docs named in section 4, write a clear implementation prompt, get approval, then implement.

The implementation target is **Electron + TypeScript + Node.js**, using **Open Cowork** (`github.com/OpenCoworkAI/open-cowork`) as the primary structural reference for the `main/renderer/preload` split, VM sandboxing, the Skills-loader pattern, and the session/IPC conventions. Orchestration is **LangGraph.js**, not a plain LangChain `AgentExecutor` — see section 10 for why that distinction is load-bearing here, not stylistic.

This supersedes the original single-shot "L4 Brain → Tool Dispatcher" model from the Review-1 design paper @doc dir. The six perception/cognition/action layers from that paper are still the contract for *what* the system perceives and can do; this file now describes *how* that work is orchestrated across a session and its subagents.

---

# 1. What you are building

- **Sessions**, not a single global agent — each user request lives inside a session the same way a chat app scopes a conversation to a thread. A session owns its own history, model, tool set, permissions, retry policy, and running agent + sandbox process.
- A **primary agent (supervisor)** per session, built as a LangGraph.js graph, that reads the task state and dispatches work to **subagents** — code, native-desktop, browser automation, and any MCP-defined tool — looping until the task's checklist is satisfied or the user must be asked something.
- **Concurrency gated by resource, not by subagent type** — any two tools or subagents run in parallel unless their declared resources actually overlap (section 11).
- The safety extensions already established: mandatory HITL approval before destructive actions, a risk classifier independent of the agent's own reasoning, a screen-content firewall before any cloud call, and VM-level sandboxing — all of which now apply per-session and regardless of which subagent triggers the action.

Build nothing beyond this pipeline. Do not overbuild a general-purpose agent platform.

---

# 2. How to work

Follow this loop for every request:

1. Read this file, then the docs named in section 4 relevant to the layer you're touching.
2. Look at the existing code and config before assuming how anything is shaped — several decisions (section 8) are intentionally left open.
3. Ask one focused question only if the task is genuinely ambiguous; otherwise pick the stated default and flag the assumption in your implementation prompt.
4. Write an implementation prompt in `prompts/` covering: the goal, the layer(s) touched, the docs you read, the code you inspected, your decisions and assumptions, the files you expect to touch, the safety implications, the acceptance criteria, and the manual test steps.
5. Get approval on the prepared prompt before writing code, unless told to skip it.
6. Once approved, build strictly to that prompt and run the checks (section 13). Close with `What I did` / `Test` / `Needs your attention` — bullets, not paragraphs.

Do not write code before the prompt is approved.

---

# 3. Non-negotiable safety rules

Unchanged in substance from before, now explicitly scoped to apply **per subagent dispatch, not just per top-level action**:

- **No subagent, and no supervisor, ever self-certifies its own action as safe.** Every dispatched tool call — regardless of which subagent emits it — passes through `sandbox/risk-classifier.ts` first, a rule-based check against the literal tool-call `args`, never against the agent's own reasoning text.
- **No raw screenshot leaves the device before redaction.** Every screenshot passes through `perception/redactor.ts` before inclusion in any model call, from any subagent.
- **Every loop is bounded.** Supervisor dispatch iterations and per-subagent retries are capped by the session's `retryPolicy` (section 7). Hitting the cap ends the turn with a status report, not a silent retry.
- **Native execution runs inside the session's VM-level sandbox** (WSL2/Lima), never bare on the host.
- **Subagents never call each other directly.** All handoffs return to the supervisor first (section 10) — a direct subagent-to-subagent chain bypasses both the risk classifier and the retry cap.
- When in doubt about whether an action is destructive, treat it as destructive.

---

# 4. Docs to lean on

- Open Cowork (`github.com/OpenCoworkAI/open-cowork`) — reference for the Electron `main/preload/renderer` split, VM sandboxing, Skills loader, and `useIPC`/`contextBridge` conventions.
- **LangGraph.js docs** — supervisor pattern, conditional edges, shared graph state, and cycles. This is the primary orchestration reference now; do not reach for a plain LangChain `AgentExecutor` for the supervisor loop.
- Google Gemini API docs — multimodal input, function/tool calling, streaming.
- Playwright docs, and the `browser-use` project — for the browser subagent.
- OpenAI Whisper docs / `faster-whisper` — for perception (L2).
- Electron docs — `globalShortcut`, `desktopCapturer`, `contextBridge` (never enable `nodeIntegration` in the renderer).
- Platform automation docs per OS — Windows UI Automation, macOS Accessibility API/AppleScript, Linux AT-SPI — for the native-desktop subagent; treat these as three separate, independently incomplete backends.

---

# 5. How the app is structured

```
autonomous-desktop-agent/
├── src/
│   ├── main/                             # restructured to match Open Cowork's source layout
│   │   ├── index.ts
│   │   ├── preflight.ts                  # startup checks: WSL2/Lima present, API keys set, hotkey free
│   │   ├── workspace-path-constraints.ts # basic path-guard sandbox fallback (no VM required)
│   │   ├── client-event-utils.ts         # shared IPC event helpers (replaces a standalone ipc/ folder)
│   │   ├── nav-server.ts                 # dev server wiring for the Vite-built renderer
│   │   ├── perception/                   # L1-L3 — no analog in Open Cowork
│   │   │   ├── global-hotkey.ts          # L1 — creates or continues a session
│   │   │   ├── audio-recorder.ts         # L2
│   │   │   ├── screen-capture.ts         # L3
│   │   │   └── redactor.ts               # screen-content firewall, before any screenshot leaves the device
│   │   ├── agent/
│   │   │   ├── agent-runner.ts           # LangGraph.js supervisor graph, one per active session
│   │   │   ├── subagent-registry.ts      # pluggable SubagentDef entries, incl. MCP-added ones
│   │   │   └── subagents/
│   │   │       ├── code-subagent.ts          # read/write/update/remove files
│   │   │       ├── native-desktop-subagent.ts
│   │   │       └── browser-subagent.ts       # Playwright / browser-use
│   │   ├── session/
│   │   │   ├── session-manager.ts        # orchestrator: owns lifecycle for every session
│   │   │   └── session-store.ts          # persistence of Session records (via db/)
│   │   ├── sandbox/                      # execution-boundary concerns: isolation + the safety gate
│   │   │   ├── vm-runner.ts              # WSL2/Lima, scoped per session
│   │   │   ├── risk-classifier.ts        # independent, non-LLM policy check
│   │   │   ├── approval-gate.ts
│   │   │   └── resource-lock-manager.ts  # global lock, keyed by declared resource
│   │   ├── mcp/
│   │   │   └── mcp-client.ts             # wraps external MCP servers into SubagentDef/ToolDef entries
│   │   ├── skills/
│   │   │   └── skills-manager.ts         # built-in + user-added skills (e.g. docx/pptx templates)
│   │   ├── tools/
│   │   │   └── tool-executor.ts          # resolves a tool call's `resources` and dispatches it
│   │   ├── memory/
│   │   │   └── memory-manager.ts         # recall/prefs + write-outcome
│   │   ├── db/
│   │   │   └── database.ts               # SQLite (+ ChromaDB client if vector recall is added)
│   │   ├── config/
│   │   │   └── config-store.ts
│   │   └── utils/
│   ├── preload/
│   │   └── index.ts                      # contextBridge only
│   └── renderer/
│       ├── SessionList.tsx               # + button, session titles, status dots
│       ├── OverlayWindow.tsx
│       ├── ApprovalDialog.tsx
│       ├── TracePanel.tsx                # consumes message_update/tool_execution_*/agent_end
│       └── hooks/useIPC.ts
├── corpus/                               # Desktop Task Corpus (DTC) tooling
├── prompts/
└── docs/eval/
```

Adopted from Open Cowork's `main/` layout as-is: `agent/`, `config/`, `db/`, `mcp/`, `memory/`, `sandbox/`, `session/`, `skills/`, `tools/`, `utils/`, and the top-level `index.ts` / `preflight.ts` / `workspace-path-constraints.ts` / `client-event-utils.ts` / `nav-server.ts`.

Dropped as unnecessary for this project's current scope:
- `cli/` — wraps invoking an external CLI coding agent; nothing here shells out to one.
- `extensions/` — would just be a second registration point for what `mcp/` and `skills/` already cover.
- `remote/` — Feishu/Slack remote control isn't part of the design paper's objectives or anything discussed so far.
- `schedule/` — recurring/scheduled runs aren't part of the six-layer design or the session model; add it back if proactive/recurring tasks become a requirement.
- A standalone `ipc/` folder — folded into `client-event-utils.ts`, with each domain module registering its own handlers.

Added, with no Open Cowork analog to borrow from, because the project can't function without them:
- `perception/` — the hotkey-trigger + audio/screenshot capture + screen-content firewall stage. Open Cowork isn't a voice/vision-triggered agent, so this is genuinely new, not a renamed borrow.
- `risk-classifier.ts` / `approval-gate.ts` / `resource-lock-manager.ts` are folded into `sandbox/` rather than given their own top-level folder, since Open Cowork has no separate safety layer and these are all execution-boundary concerns anyway.

---

# 6. Session lifecycle

Five states — **idle is a real state**, not just "nothing running":

```
created → idle → running → idle → ... → stopped → deleted
```

- **create** — user clicks `+` and optionally names it, or leaves it blank; title is generated from the first prompt's content once that turn resolves, not before. Persists a `Session` row. Does not start the agent or sandbox.
- **start** — boots `AgentRunner` + `Sandbox` for this session, left warm in `idle`. Do this once per session, not once per prompt, to avoid paying cold-start latency on every message.
- **running** — exactly while a turn is in flight, from prompt enqueue to `run()` resolving.
- **stop** — tears down `AgentRunner` + `Sandbox` processes; conversation history stays in SQLite.
- **delete** — removes the session row and history entirely.

A prompt to an existing session skips `create`/`start` and goes straight to enqueue-and-run.

---

# 7. Contracts

Fixed shapes; everything else about each is yours to choose sensibly.

**Session record:**
```ts
Session {
  id, title, status: created | idle | running | stopped | deleted
  conversationHistory: Message[]
  model: string
  tools: ToolDef[]
  toolExecutionLog: ToolExecution[]
  permissionHooks: PermissionConfig   // per-session; may only tighten the global default, never loosen it
  retryPolicy: { maxRetries: number, maxLoopIterations: number }
  contextCompaction: { strategy: "summarize" | "truncate", threshold: number }
}
```

**Subagent definition (registry entry):**
```ts
SubagentDef {
  name: string                // "code" | "native-desktop" | "browser" | ...
  description: string         // used by the supervisor to route
  tools: ToolDef[]
  systemPrompt: string
}
```
Resource needs are **not** declared statically here, because they can depend on a specific call's args (see `resources` on Tool call below) — a subagent's type is never what concurrency is decided on.

**IPC / event contract** — reuse this vocabulary verbatim, it already maps directly onto `TracePanel`:
`session.start` / `session.continue` → `startSession`/`continueSession` → `enqueue prompt` → `processPrompt` → loop of (`message_update` / `message_end`; on tool use: `tool_execution_start` → execute → `tool_execution_end` → trace pushed to renderer → model called again) → `agent_end` → `run()` resolves → session `idle` → `session.status` → renderer clears loading state.

**Tool call** (subagent → supervisor, and supervisor → dispatch): `{ restatedGoal, reasoningTrace, tool, action, args, confidence, resources: string[] }`. `resources` is computed from `args` by the tool's own resolver — e.g. a file-write resolves to `["file:/path/x.docx"]`, a real-input action resolves to `["native-input"]`, a browser action resolves to `["browser-context:<id>"]` — and is what the resource-lock manager checks before dispatch, never the tool or subagent's name or kind. Low `confidence` routes to a clarification turn, not execution.

**Risk-classifier rule:** `{ pattern, category: "file-delete" | "credential-entry" | "payment" | "network-egress" | "mass-modify", verdict: "block-until-approved" | "allow" }`, matched against literal `args` only — never against `reasoningTrace`.

**Memory record:** `{ sessionId, timestamp, transcriptRef, redactedScreenshotRef, toolCall, outcome, userPrefs }`. Raw screenshots are never persisted.

**DTC corpus episode:** `{ audioClip, screenshot, verifiedTranscript, groundTruthToolCall, successLabel }`.

---

# 8. Open design decisions — confirm before implementing

- End-of-utterance detection: default push-to-talk (hold hotkey), revisit VAD later.
- Screenshot scope: default full virtual desktop, not just active window.
- Per-OS native-control backend: Windows/macOS/Linux are three separate, independently incomplete backends.
- Context compaction strategy: summarize-on-threshold vs. hard-truncate — affects long research-style sessions differently.
- `permissionHooks` may only be tightened per session below the global default, never loosened, without a separate explicit user action.
- Title-generation model: same primary model vs. a cheap dedicated one — a cost/latency tradeoff paid on every new session.

---

# 9. How perception must behave

- L1 registers one global hotkey and does nothing else while idle.
- L2 and L3 fire concurrently on trigger.
- A trigger either creates a new session or continues the currently active one — never spins up a second concurrent session from the same hotkey press.
- Nothing captured is persisted beyond the session unless the user opts into DTC corpus contribution, and even then it passes through the firewall first.

---

# 10. How the supervisor and subagents must behave

Build the primary agent as a **LangGraph.js supervisor graph**: one supervisor node, one node per registered subagent, and a conditional edge that always returns control to the supervisor after a subagent step — never a direct subagent-to-subagent edge. The supervisor reads the shared graph state (the task checklist) and decides the next dispatch: the same subagent again, a different one, or `FINISH`.

This is a correction worth restating: a hand-rolled chain (`subagent1 → subagent2 → subagent3 → loop`) bypasses the one place the safety gate and retry cap live. The hub-and-spoke shape is what makes both enforceable.

**Concurrency is a general property of dispatch, not a special case for any two named subagent types.** When the supervisor's checklist calls for independent work, it fans out to multiple subagent nodes at once (LangGraph's parallel branches / `Send` API), rather than only ever dispatching one at a time. Whether two of those branches actually run simultaneously or one waits is decided at dispatch time by the resource-lock manager (section 11) checking each call's declared `resources` — never by which kind of subagent is involved. Adding a new subagent (printer, clipboard, audio, a second code subagent) must not require touching this dispatch logic at all.

- Supervisor turns the user's request into an explicit **checklist** (e.g., required sections × required sources) before dispatching anything; every dispatch decision reads and updates this shared state.
- A subagent failure reports back to the supervisor rather than retrying itself; the supervisor retries up to `retryPolicy.maxRetries`, then surfaces the failure to the user.
- Dispatch loop iterations are capped by `retryPolicy.maxLoopIterations`; hitting the cap ends the turn with a status report.
- The **web subagent synthesizes** scraped content into structured claim objects (`{ sourceUrl, claim, supportingText, citationMeta }`) before handing it to the supervisor or another subagent — never passes raw HTML upward.
- Once the checklist is satisfied, supervisor emits `agent_end`, compiles/finalizes output, and gives a summary + asks for follow-up.

---

# 11. Concurrency and action-safety rules

Concurrency is decided **per resource, not per subagent type.** `resource-lock-manager.ts` holds a table of currently-held resource keys, global across all sessions. Before any dispatch executes, its `resources` (section 7) are checked against that table:

- If none of a call's `resources` are currently held, it acquires them and runs — in parallel with any other call whose `resources` don't overlap, regardless of whether the two calls come from the same subagent, different subagents, or two instances of the same subagent.
- If any `resources` overlap with something already held, the call queues until released — this is what actually prevents corruption, not a rule about which named subagents are allowed to coexist.

Worked examples of what falls out of this automatically, none of them hardcoded:
- Two browser actions targeting different tabs/contexts → different `browser-context:<id>` keys → run concurrently.
- Two browser actions targeting the *same* tab → same key → serialized.
- A native-input action and a file-write action → disjoint keys (`native-input`, `file:<path>`) → run concurrently.
- Two native-input actions, from any subagent(s) → both need `native-input` → serialized, which is what actually prevents two subagents from injecting real keystrokes/clicks at the same time.
- Two code-subagent calls writing to different files → disjoint `file:<path>` keys → run concurrently; to the same file → serialized.

Split-screen layout is an explicit native action (window snap-left/snap-right) — never assumed as a side effect of opening two apps. Every dispatched tool call, from any subagent, still passes: `risk-classifier.ts` → (if flagged) `approval-gate.ts` blocks until explicit user confirmation → `sandbox/vm-runner.ts` executes inside the session's VM boundary → outcome written to memory. A destructive action (e.g., overwriting an existing file) requires approval regardless of which subagent triggered it, and regardless of whether it ran concurrently with other work.

---

# 12. Things that will trip you up

- A direct subagent-to-subagent handoff will *work* in a demo and quietly bypass the risk classifier and retry cap — this is the single easiest mistake to make when translating the "loop to subagent1" phrasing literally. Route through the supervisor, always.
- Hardcoding concurrency around specific subagent *types* (e.g. "browser is always safe next to native") breaks the moment a new subagent is added — key every lock by the `resources` a call actually resolves to, and keep that table global across sessions, not per-session or per-subagent-kind.
- If `start` re-boots the agent/sandbox on every prompt instead of once per session, every message pays cold-start latency — keep both warm through `idle`.
- Title generation needs content to generate from; firing it before the first turn resolves produces a generic or empty title.
- A retry against a genuinely broken UI state (not just misread) will loop forever without the cap in section 10 — always cap it.
- Docker sandboxing is a development-time convenience, not the production boundary — production execution needs the session-scoped WSL2/Lima runner.
- `browser-use` + Playwright has no built-in answer for session persistence, saved logins, or CAPTCHAs — don't assume multi-step browser tasks "just work" across runs until tested.

---

# 13. Checks to run

Run these and report the real output — never claim a check passed without running it.

- Standard: `tsc`/type-check, lint, production Electron build via `electron-builder` when main-process, IPC, or renderer code changes.
- **Concurrency test**: any two dispatches with non-overlapping `resources` run truly simultaneously; any two with overlapping `resources` are serialized and never execute at the same time. Cover at least one same-subagent-kind pair (e.g. two code writes to different files run concurrently, to the same file serialize) and one cross-kind pair (e.g. browser + native run concurrently; two native-input calls from any source serialize) — not just browser-vs-native.
- **Session persistence test**: create a session, populate history, restart the app, confirm the session and its history survive.
- Safety-specific: a fixed set of adversarial DTC episodes where screen/transcript content tries to trigger a destructive action without approval — the gate must catch 100% before anything ships.
- Evaluation metrics from the design paper, run against the DTC corpus: Intent Recognition Accuracy, Tool Dispatch Accuracy, Task Completion Rate, End-to-End Latency.

---

# 14. When in doubt

Safety over autonomy: if an action's destructiveness is unclear, route it to the approval gate. Keep subagents registry-driven, not hardcoded. Route every handoff through the supervisor, never subagent-to-subagent. When unsure how to wire IPC, sandboxing, sessions, or memory, check how Open Cowork does it first. Log every reasoning step and tool call to `TracePanel.tsx` and to memory. Ask one focused question before writing code when this file is ambiguous; otherwise use the stated default and flag the assumption in the implementation prompt.