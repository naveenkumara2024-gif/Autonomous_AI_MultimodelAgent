# Automation overlay — a live trace + approval window that stays on top while the agent works

## Goal
While an automation turn runs, show a compact, movable, resizable window that stays above every
other window — including windows the agent itself opens — and shows the live trace steps and any
pending approval, so the user can watch the target app and the agent's steps at the same time and
approve or deny from the same place. The app's main window is minimized while the agent acts so it
doesn't cover the app being automated.

## Layers touched
Electron main (new `overlay/` module, `index.ts` event fan-out, config), preload + renderer (new
`#automation` route reusing the trace builder and approval model), and — because this feature puts a
clickable *Approve* button permanently on top of the desktop the agent is clicking — the MCP input
tools (`click`, `drag`, `key_press`, `type_text`) for a self-approval guard. Supervisor, subagents,
risk classifier, approval-gate semantics and resource locks are **not** changed.

## Docs consulted
- AGENTS.md §3 (no path by which an agent approves its own action; loops bounded), §5 (layout),
  §7 (IPC vocabulary reused verbatim: `trace.event`, `approval.request/resolved`,
  `session.status`), §9 (perception overlay precedent), §11 (every call still passes classifier →
  approval → lock), §14 (safety over autonomy).
- Electron docs: `BrowserWindow` `alwaysOnTop` levels, `focusable`, `resizable`,
  `setContentProtection`, `showInactive`, `-webkit-app-region`. Known Electron limitation to
  confirm: transparent windows are not resizable on Windows.
- Win32: `WindowFromPoint`, `GetAncestor(GA_ROOT)`, `GetWindowThreadProcessId`, `GetForegroundWindow`.
- `prompts/stage-4-voice-hotkey-trigger.md` (the existing voice overlay's decisions).

## Code inspected
- `perception/overlay-window.ts` + `renderer/OverlayWindow.tsx` — the **voice** overlay: transparent,
  fixed 320×96, `movable/resizable: false`, `focusable: false`, level `"screen-saver"`, shown
  bottom-right, route `#overlay`. Not reusable as-is (it cannot be moved or resized, and
  transparent windows can't be resized on Windows), so this is a **second, separate window**.
- `main/index.ts` — `send()` is bound to the main window only, and `TraceStore`, `ApprovalGate` and
  `SessionManager` all emit through it, so a second window currently receives nothing.
  `approval.respond` / `approval.list` accept **any** sender (no `fromOverlay`-style check).
  `win.on("closed", app.quit)` already exists for the voice overlay's sake.
- `agent/trace.ts` — event types (`agent_start`, `tool_execution_start`, `approval_requested`,
  `agent_end`, …) and the `trace.event` push; `renderer/TracePanel.tsx` exports `buildTurnView`
  (pure), `renderer/hooks/useTrace.ts` exports `useTrace` / `useApprovals`, `ApprovalDialog.tsx`
  has the field/label logic for risk categories and the countdown.
- `tools/tool-executor.ts` — single dispatch path; classification, approval, locks.
- `mcp/mcp-client.ts:49-55` — the MCP server's env is built from `process.env`, so a host PID can
  be passed in. `mcp-server/win32/ffi.ts` — has `SetCursorPos`/`GetCursorPos` but none of the
  window-from-point functions needed for the guard.
- `mcp-server/tools/mouse.ts` — `click`/`drag` resolve the final screen point inside the MCP
  server (cache labels, normalized coords, etc.), so main cannot know where a click will land.

## Decisions / assumptions (flagging for approval)

1. **A new window, route `#automation`, not a mode of the voice overlay.** Own class
   `overlay/automation-overlay.ts`. Not in the §5 layout; added because §5's perception overlay is
   non-interactive by design and nothing else models an interactive always-on-top window.
2. **Window shape.** Frameless, **not transparent** (so it can be resized), `resizable: true`,
   `skipTaskbar: true`, rounded dark panel drawn by CSS, a header strip as the drag region
   (`-webkit-app-region: drag`, buttons `no-drag`). Default **420×540**, min **300×160**, placed in
   the top-right of the primary work area (the voice indicator is bottom-right, so they don't
   collide). Bounds persist to `<userData>/automation-overlay.json` and are clamped to a visible
   display on load. A **collapse** button shrinks it to the header strip (one line: status, step
   count, elapsed) — that is the "compact" mode.
3. **Stays on top, including over new windows.** `setAlwaysOnTop(true, "screen-saver")` (same level
   the voice overlay uses → `HWND_TOPMOST`). Other apps' new windows are not topmost, so they open
   *under* it. To survive another app asserting topmost, re-assert with `moveTop()` on each
   `tool_execution_start` and on a 2 s timer while visible. **Limits I cannot lift:** exclusive
   full-screen games and the UAC secure desktop.
4. **Never steals focus.** `focusable: false` + `showInactive()`. The agent types with real
   keystrokes into whatever app is focused, so clicking Approve must not move focus to the overlay.
   Consequence: mouse only — there is no keyboard shortcut (Esc to deny) in the overlay.
   **Risk to verify:** that drag and edge-resize still work on a non-activating window. Fallback if
   they don't: briefly `setFocusable(true)` only while the pointer is on the header/edges, then
   restore the previous foreground window.
5. **When it appears.** Created lazily on first use, then kept (hidden when idle) so later shows are
   instant. It appears **300 ms after the first tool execution of a turn** (so a 0.6 s fast-path
   "open calculator" doesn't flash a window) — **or immediately on any approval request**. A pure
   chat answer with no tool calls never shows it.
6. **Minimize the main window.** On first show of a turn, if `automationMinimizeMainWindow` (default
   `true`) and the main window is visible, minimize it and remember that *we* did. **It is not
   auto-restored** when the turn ends — restoring would steal focus back from the app the user was
   just looking at. Instead the overlay shows the final reply and an **Open app** button. If the
   user minimized/closed it themselves, we don't touch it.
7. **What it shows** (all from existing events, no new agent instrumentation):
   - Header: status dot + label (`Working…` / `Needs your approval` / `Done · 4.2 s` / `Stopped` /
     `Failed`), the session title, **Stop** (calls the existing `session.cancel` — essential since
     the main window is minimized), collapse, hide.
   - Plan: the supervisor checklist as a one-line-per-item strip (hidden when there is one item).
   - Steps: one compact row per tool call — status dot, tool, intent, duration, risk/approval chip;
     click a row to expand args/result (reusing `buildTurnView` so the logic isn't duplicated).
     Auto-scrolls to the newest step.
   - **Approval card pinned under the header**, so it can never scroll out of view: intent, risk
     category chips, reasons, the command/text/files being run, countdown, **Deny** (left, the
     visually default choice) and **Approve**. Multiple pending → "1 of N".
   - Footer: the agent's final reply once the turn ends.
8. **Approvals work from both windows.** Both render the same global pending list; whichever
   answers first wins and `approval.resolved` removes the card from the other. **An approval request
   force-shows the overlay even if the user closed it** — a pending approval can't be left with
   nowhere to answer it.
9. **After the turn.** On `done` the overlay auto-hides after 8 s (paused while the pointer is over
   it, and cancelled by any interaction). On `blocked` / `failed` / `cancelled` it stays until
   dismissed. Hiding it manually keeps it hidden until the next turn (or an approval).
10. **Multiple sessions.** The step list follows the session whose turn started most recently;
    approvals show for every session, tagged with the session title. No per-session windows.
11. **Event plumbing.** `index.ts`'s `send` becomes a broadcast to the main window **and** the
    overlay (same channels, same payloads). A small `AutomationController` observes the same
    stream (`trace.event`, `session.status`, `approval.*`) and owns show/hide/minimize/auto-hide, so
    agent code is untouched. On first load the overlay hydrates from `listTrace` / `listApprovals`
    (events emitted before its page finished loading are not lost).
12. **Settings.** `automationOverlayEnabled` (default `true`) and `automationMinimizeMainWindow`
    (default `true`) in `config.json`. No settings UI exists yet (same as `actionCacheEnabled`).
13. **Not doing:** per-monitor smart placement, opacity slider, click-through mode, tray icon,
    detaching individual trace rows, showing screenshots in the overlay (they stay in the main
    window's trace; the overlay is for glanceable steps).

### Safety: the overlay must not be an automation target (the part that needs care)
A permanent Approve button on top of the desktop is a button the agent's own `click` tool could
press. The existing main-window dialog has the same theoretical hole (Tab → Enter via `key_press`),
but an always-on-top window over the app being automated makes it far more likely. §3 says there is
"no path by which the agent can approve its own request", so:

14. **Hide it from the model.** `setContentProtection(true)` on the overlay → excluded from screen
    capture (`WDA_EXCLUDEFROMCAPTURE` on Windows 10 2004+). The model's screenshots then never show
    the overlay, so it never picks it as a target. **To verify empirically with this app's own
    capture** — if the mode on this machine is "black rectangle" instead of "excluded", I will say
    so and not rely on it.
15. **Refuse synthetic input aimed at the app's own windows (the real guard, in the MCP server).**
    The host passes its PID (`AGENT_HOST_PID`) in the MCP server's env. New
    `mcp-server/win32/own-windows.ts`:
    - `click` / `drag` (both endpoints): after resolving the final screen point and **before**
      `SetCursorPos`, `WindowFromPoint → GetAncestor(GA_ROOT) → GetWindowThreadProcessId`; if the
      owner is the host PID, **refuse** with a structured error naming the window.
    - `key_press` / `type_text`: refuse if `GetForegroundWindow()` is owned by the host PID (closes
      the Tab→Enter route into the main window's dialog).
    - Pure decision function (`isOwnWindow(pid, hostPid)` + the hit-test injected) so it is
      unit-tested without real windows; the real HWND→PID lookup is verified manually and logged
      once at startup in dev.
16. **Dodge, then retry once.** A refused click because the *overlay is covering a legitimate target*
    (e.g. a close button in the top-right of the app being automated) must not strand the agent. The
    error carries `{ blockedBy: "automation-overlay", point }`; `ToolExecutor` recognizes it, asks the
    overlay to move to the display corner farthest from the point, and retries the **same,
    already-approved** call **once**. Still covered → the error goes back to the model. This is not
    a new loop: it is bounded at one retry and re-uses the call's existing approval.
    *This is the first thing I would cut if you want a smaller change — but without it the overlay
    will regularly block clicks near screen edges.*
17. **Tighten who may answer approvals.** `approval.respond` / `approval.list` currently accept any
    renderer. Restrict them to the main window and the automation overlay (by `webContents.id`),
    same pattern as the voice handlers' `fromOverlay`. The voice overlay shares the preload bridge
    and should not be able to approve anything.
18. **Rejected alternative: hold-to-approve / confirm-twice.** Adds friction on every legitimate
    approval, and the real fix is the guard above. Revisit only if the guard proves leaky.

## Files to touch
Create:
- `src/main/overlay/automation-overlay.ts` — the window: lazy create, bounds persistence/clamp,
  topmost re-assert, `showInactive`, collapse/expand sizing, content protection, `dodge(point)`.
- `src/main/overlay/automation-controller.ts` — decisions only (show delay, force-show on approval,
  auto-hide, minimize-once, user-closed state); window and clock injected so it is unit-testable.
- `src/main/overlay/automation-controller.test.ts`
- `src/renderer/AutomationOverlay.tsx` — the UI (header, plan strip, compact steps, pinned approval
  card, footer reply); reuses `buildTurnView`, `useTrace`, `useApprovals`.
- `src/mcp-server/win32/own-windows.ts` + `own-windows.test.ts`

Modify:
- `src/main/index.ts` — broadcast `send`, create the overlay/controller, sender restriction on
  `approval.respond`/`approval.list`, new handlers (`automation.hide`, `automation.setCollapsed`,
  `automation.openMainWindow`), pass the host PID to the MCP client.
- `src/main/mcp/mcp-client.ts` — add `AGENT_HOST_PID` to the server env (explicit, not from the
  `process.env` copy loop).
- `src/main/config/config-store.ts` — the two keys + defaults (existing missing-key migration
  rewrites `config.json`).
- `src/main/tools/tool-executor.ts` (+ extend `tool-executor.test.ts`) — the one-retry dodge, behind
  an optional dep so existing tests are unaffected.
- `src/preload/index.ts`, `src/renderer/vite-env.d.ts`, `src/renderer/main.tsx` (route),
  `src/renderer/types.ts` — bridge methods, `automation.focus` event channel, `#automation` route.
- `src/mcp-server/win32/ffi.ts` — `WindowFromPoint`, `GetAncestor`, `GetWindowThreadProcessId`,
  `GetForegroundWindow`.
- `src/mcp-server/tools/mouse.ts`, `src/mcp-server/tools/keyboard.ts` — call the guard.
- `src/renderer/TracePanel.tsx` — export the `ToolRow`/`TurnView` types only (no behavior change).

## Safety implications
- Overlay approvals use the same `ApprovalGate`: Deny / timeout / cancel / window-closed all resolve
  as *not approved*; nothing about approval semantics changes. The risk classifier still matches
  literal tool-call `args` only.
- New surface: a second window that can approve. Mitigated by decisions 14–17 (hidden from capture,
  agent input refused against our own windows, sender-restricted IPC, non-focusable).
- No tool-call `resources` change: window management is not a tool call, so the lock table is
  untouched. A refused click never reaches `SendInput`.
- The overlay renders trace text that can contain page/screen-derived strings; it renders them as
  React text (never `dangerouslySetInnerHTML`), same as `TracePanel`.
- Nothing new is persisted except window bounds. No audio or screenshots are stored.

## Acceptance criteria
1. Starting an automation turn ("open notepad and type hello") shows the overlay on top of the
   target app within ~0.5 s of the first tool call, with steps appearing live; the main window is
   minimized.
2. A window the agent opens *after* the overlay is shown (Notepad, a browser window) appears
   **beneath** the overlay.
3. The overlay can be dragged by its header and resized from its edges; size/position survive an app
   restart and are clamped if a monitor is gone. Collapse leaves a one-line strip.
4. A flagged action (`run_powershell Remove-Item …`) shows the approval card in the overlay; Deny
   and Approve both work; the main window's dialog (when visible) disappears on resolve.
5. Pressing Approve/Deny does **not** change the foreground window (the agent's next keystroke
   still goes to the target app).
6. With the overlay closed by the user, a new approval request re-shows it.
7. `click` aimed at a point inside the overlay's or main window's bounds is refused and never
   reaches `SendInput`; with the overlay covering a target the call dodges and succeeds on the
   single retry; `key_press` with the app's own window focused is refused.
8. Screenshots the agent takes do not contain the overlay (verified by looking at a saved trace
   image on this machine).
9. `voice.*` handlers and the voice overlay are unchanged; the voice overlay can no longer call
   `approval.respond`.
10. `automationOverlayEnabled: false` → no overlay, no minimize, today's behavior.
11. `bun run typecheck`, `bun test` (existing 181 plus new), and `bun run build` pass with real
    output reported. No lint script exists.

## Manual test steps
1. `bun run dev`. Send "open notepad and type hello world". Watch overlay appear, steps stream,
   main window minimize, overlay auto-hide ~8 s after done.
2. Send a request that needs approval (e.g. delete a scratch file). Approve from the overlay, then
   repeat and Deny. Try it with the main window restored too — answer from either.
3. Drag the overlay over Notepad's close button and ask the agent to close Notepad: expect the
   dodge, not a stuck click.
4. Close the overlay mid-turn, then trigger an approval: it must come back.
5. Resize, collapse, restart the app: size/position restored.
6. Press the voice hotkey while the overlay is up: both windows coexist.

## Open assumptions (flag if wrong)
- A non-activating (`focusable: false`) frameless window can still be dragged and edge-resized on
  Windows 11 — my expectation, not yet tested (fallback in decision 4).
- Chromium's top-level HWNDs for our windows belong to the Electron **main** process PID, so
  comparing the owner PID to `process.pid` is sufficient. Verified manually before relying on it.
- Defaults I chose that you may want flipped: auto-hide after 8 s on success; **don't** auto-restore
  the main window; overlay only appears once a tool actually runs; minimize on by default.

## As built: changes to the plan found during implementation

- **Keyboard guard moved to main and made conditional (revises decision 15).** The plan had the MCP
  server refuse `key_press`/`type_text` whenever the foreground window belongs to the app. That
  would also refuse `key_press win` whenever the user sent the prompt from the app window, which is
  a normal flow. It is now `ToolExecutor`'s `inputBlockedReason`: keyboard input is refused only
  **while an approval is pending and one of our windows has OS focus** (`BrowserWindow
  .getFocusedWindow()`), which is the only situation where a stray Tab/Enter could answer it. The
  automation overlay itself is non-focusable, so it can never be that window. The click/drag guard
  stays in the MCP server and is unconditional.
- **The controller does not consume `session.status`.** `agent_start` / `agent_end` from the trace
  stream already carry everything needed (turn id, final status), so one fewer event is tracked.
- **Collapsed state is read from the window height** (<= 64 px) rather than synced over IPC, so the
  renderer can't disagree with the saved window state after a restart.
- **Extra module:** `overlay/overlay-geometry.ts` holds the pure placement maths (restore/clamp,
  default corner, dodge corner) so it is unit-tested without Electron.
- **Hide is disabled in the header while an approval is pending**, and `automation.hide` is refused
  in main as well (not just greyed out in the UI).

### Verified here
| Check | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun test` | 224 pass, 0 fail (181 before; +43: controller, geometry, own-window guard, executor dodge/keyboard guard) |
| `bun run build` | exit 0 (tsc, MCP exe, whisper setup, Vite, electron-builder NSIS installer) |
| Window options on this machine (throwaway probe: a `BrowserWindow` with the overlay's exact options, driven with real mouse input) | see below |

Probe results (Windows 11, display scaled above 100%):
- `WS_EX_TOPMOST` and `WS_EX_NOACTIVATE` both set; display affinity `0x11`
  (`WDA_EXCLUDEFROMCAPTURE`).
- A screen capture at the window's centre returned the desktop behind it, not the window's own
  (magenta) pixels — the window **is excluded from capture**.
- `WindowFromPoint → GetAncestor(GA_ROOT) → GetWindowThreadProcessId` at a point inside the window
  returned the Electron process's own PID — the PID the MCP guard compares against.
- A real mouse click on the window did **not** change the foreground window.
- Header drag moved the window by the dragged amount without changing its size; resizing from the
  right edge and from the bottom-right corner both worked, on a non-activating window.

### Not verified (needs you)
- An end-to-end run in the real app: overlay appearing during a live agent turn, the approval card
  answering a real flagged action, main-window minimize, the dodge on a real covered click, and
  position/size persisting across a restart. The manual steps above cover these; running them
  drives your mouse and keyboard, so I did not do it unattended.
- The theme in the overlay is read once at load (same `localStorage` key as the main window); a
  theme toggle while the overlay is open is not picked up until its next load.
