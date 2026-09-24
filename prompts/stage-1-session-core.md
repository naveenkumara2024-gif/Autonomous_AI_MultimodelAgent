# Stage 1 — Session core (no agent, no perception)

## Goal
Implement the session abstraction everything else plugs into: the five-state lifecycle
(section 6), the `Session` contract (section 7), SQLite persistence, and enough renderer UI
(`SessionList.tsx` + a bare message list/input) to create a session, append plain text messages
to its history, and prove that history survives an app restart. No agent, no LLM call, no tool
execution, no perception — those are Stage 2+.

## Layers touched
`src/main/session/`, `src/main/db/`, `src/main/config/`, IPC wiring in `client-event-utils.ts`
consumers, `src/preload/index.ts` additions, `src/renderer/` (`SessionList.tsx`, a minimal
session detail view, `App.tsx` rewire).

## Docs consulted
- AGENTS.md sections 6 (lifecycle), 7 (`Session` contract, IPC vocabulary), 8 (open decisions:
  `permissionHooks` tighten-only, title-gen model choice).
- Open Cowork, fetched live for real conventions rather than guessing:
  - `db/database.ts`: uses **better-sqlite3**, DB at `<userData>/data/cowork.db`, schema-on-read
    migration via an `ensureColumn()` allowlist helper (no versioned migration files), tables for
    `sessions`, `messages`, `trace_steps`, `scheduled_tasks`, `memory_entries`, `skills`, foreign
    keys to `sessions` with cascade delete.
  - `sessions` table columns (real, quoted): `id, title, status, cwd, mounted_paths, allowed_tools,
    memory_enabled, model, created_at, updated_at` (plus provider-specific thread-id columns not
    relevant here).
  - `session/session-manager.ts` (45KB — in Open Cowork this one file also owns agent
    orchestration, which AGENTS.md section 5 deliberately splits out into `agent/agent-runner.ts`
    instead): constructor takes an already-open `db` and a `sendToRenderer` callback rather than
    owning IPC wiring itself; renderer events actually used include `'session.update'` and
    `'session.status'` — confirms section 7's IPC vocabulary is not invented, it's load-bearing;
    status there is only `'idle' | 'running'` at the DB level (simpler than AGENTS.md's five-state
    lifecycle, which is a deliberate AGENTS.md expansion, so Stage 1 follows AGENTS.md's fuller
    lifecycle, not Open Cowork's reduced one).

## Code inspected
- Stage 0 output: `src/main/index.ts`, `src/main/client-event-utils.ts` (the `registerHandler`
  pattern this stage's handlers plug into), `src/preload/index.ts` (single `agentBridge` object,
  extended here — not replaced), `src/renderer/App.tsx` (currently just the version-check
  placeholder, gets replaced with the real shell).
- `package.json`/`tsconfig.node.json` from Stage 0.

## Decisions / assumptions (flagging for approval)
1. **SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3`.**
   Deviation from Open Cowork's reference, flagged explicitly: `better-sqlite3` is a native addon
   that must be recompiled against Electron's exact Node ABI (`@electron/rebuild` /
   `electron-builder install-app-deps`) before it will load inside a real Electron process —
   `bun install` alone compiles it against Bun's own ABI. Stage 0 already hit one Bun/Electron
   runtime friction point (`ELECTRON_RUN_AS_NODE`); adding a second one (native module ABI
   mismatch breaking `bun run dev` until a separate rebuild step is remembered) is an avoidable
   footgun. `node:sqlite` ships inside the Node version Electron 41 bundles (confirmed ≥22, and
   Stage 0's crash log showed Node 24.x under the hood) — zero extra dependency, zero rebuild
   step, same synchronous-API ergonomics Open Cowork relies on `better-sqlite3` for.
2. **DB file at `<userData>/data/agent.db`**, mirroring Open Cowork's location pattern.
3. **Schema-on-read via an `ensureColumn()` allowlist helper**, same technique as Open Cowork,
   since no migration framework exists yet and this stage shouldn't introduce one.
4. **Normalized tables, not JSON blobs, for `conversationHistory` and `toolExecutionLog`.**
   `sessions` holds session-level fields; `messages` and `tool_executions` are separate tables
   with `session_id` FK + `ON DELETE CASCADE`, mirroring Open Cowork's `messages`/`trace_steps`
   split. `tool_executions` is schema-ready but nothing writes to it until Stage 3
   (`tool-executor.ts`) exists — it is not populated or tested in this stage.
5. **`continueSession()` in this stage only appends a `role: "user"` message row and immediately
   returns to `idle`.** There is no agent to produce a reply yet. This is the one deliberately
   "thin but real" path (same philosophy as Stage 0's single IPC round trip) that lets the
   persistence contract actually be exercised by hand instead of trusting untested plumbing.
   `message_update`/`tool_execution_*`/`agent_end` events from section 7's IPC vocabulary are
   **not** implemented here — they belong to the real supervisor loop (Stage 4/5) and would be
   fake if added now with nothing producing them.
6. **`start()` is an honest stub.** Section 6 says `start` boots `AgentRunner` + `Sandbox` and
   leaves the session warm in `idle`; neither exists until Stage 2 (sandbox) / Stage 4 (agent).
   Stage 1's `start()` transitions `created → idle` and logs
   `"agent/sandbox boot stub — real boot arrives in Stage 2/4"` — it must not pretend anything was
   booted.
7. **New sessions inherit `config-store.ts`'s global defaults verbatim** for `model`,
   `permissionHooks`, `retryPolicy`, `contextCompaction` — no per-session override UI exists yet.
   Section 8's tighten-only rule for `permissionHooks` has no caller to violate it yet, so the
   enforcing merge function is deferred to whichever stage adds a per-session override path,
   rather than building and unit-testing a guard against a call site that doesn't exist (would be
   exactly the kind of half-finished implementation AGENTS.md says not to do).
8. **Title = the first message's content, truncated to 60 chars, set once that first message is
   appended — not before.** Real LLM-based title generation (section 8's open decision: same
   model vs. a cheap dedicated one) is deferred to Stage 12; no model-calling layer exists yet to
   generate one properly, and a fake placeholder title would violate the "not before" rule for the
   wrong reason (no title-worthy content yet) rather than the right one (no model yet).
9. **`config-store.ts` persists to `<userData>/config.json`** via plain `node:fs`, not a DB table
   — it's a handful of global scalars/objects, not row-oriented data, and keeping it out of SQLite
   avoids coupling config reads to the DB being open.

## Files to touch
Create:
- `src/main/db/database.ts` — `node:sqlite` connection, schema init (`sessions`, `messages`,
  `tool_executions`), `ensureColumn()` helper.
- `src/main/config/config-store.ts` — typed global defaults, read/write `config.json`.
- `src/main/session/session-store.ts` — pure persistence: row↔`Session`/`Message` mapping, CRUD.
- `src/main/session/session-manager.ts` — in-memory orchestration: `createSession`,
  `startSession`, `continueSession`, `stopSession`, `deleteSession`, `listSessions`, emits
  `session.update`/`session.status` via an injected `sendToRenderer`.
- `src/renderer/SessionList.tsx`
- `src/renderer/hooks/useIPC.ts` — thin wrapper over `window.agentBridge` + event subscriptions.

Modify:
- `src/main/index.ts` — open DB, construct `SessionManager`, register the six session IPC
  handlers (`session.list/create/start/continue/stop/delete`) via `registerHandler`, wire
  `sendToRenderer` to `win.webContents.send`.
- `src/preload/index.ts` — extend `agentBridge` with the session methods + an `onSessionEvent`
  subscription (`ipcRenderer.on`), keep `getAppVersion` as-is.
- `src/renderer/vite-env.d.ts` — extend the `Window.agentBridge` ambient type to match.
- `src/renderer/App.tsx` — host `SessionList` + selected session's message list/input; keep the
  Stage 0 app-version line, moved to a small footer instead of the whole screen.
- `package.json` — no new runtime deps needed (`node:sqlite` is built in); bump `@types/node` if
  its currently-installed version predates `node:sqlite` types.

## Safety implications
- Nothing in this stage executes a tool, touches the filesystem beyond the session DB/config
  files, or reaches the network — `risk-classifier.ts`/`approval-gate.ts` correctly don't exist
  yet and nothing here needs them. `continueSession()` only ever writes the user's own typed text
  into a `messages` row; it never interprets that text as a command.
- `tool_executions` table exists but stays empty this stage — verified by test, not just asserted.

## Acceptance criteria
1. Create a session via the `+` button → row appears in `sessions`, status `created` → `idle`
   after `start()`'s stub runs, `SessionList` shows it with a status dot.
2. Type a message, send → appended to `messages`, visible in the detail view, session title
   updates from the first message once (not before), status flips `idle → running → idle`
   (observable via the `session.status` event, even though the "running" window is near-instant).
3. Stop a session → status `stopped`; Delete → row and its `messages`/`tool_executions` rows gone
   (cascade), `SessionList` updates via `session.update`.
4. **Restart the app** → previously created (non-deleted) sessions and their message history
   reload from `<userData>/data/agent.db` unchanged.
5. `bun run typecheck` clean.
6. `bun run dev` — DevTools console shows no errors during the above flow.

## Manual test steps
1. `bun run dev`.
2. Click `+`, confirm a new session appears with a placeholder/empty title and `idle` status.
3. Type "test message one", send. Confirm it appears in the message list and the session title
   updates to a truncated version of it.
4. Send a second message, confirm it appends (doesn't replace) and status briefly shows
   `running` then returns to `idle`.
5. Create a second session, confirm both are listed independently with correct message counts.
6. Fully quit and relaunch the app (`bun run dev` again). Confirm both sessions and all four
   messages are still there, in order.
7. Delete one session, confirm it disappears from the list and (inspecting
   `<userData>/data/agent.db` with a SQLite browser, or a quick `node:sqlite` read) its message
   rows are actually gone, not just hidden.
