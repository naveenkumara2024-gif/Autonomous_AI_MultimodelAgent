# Fix: "Session" button created two sessions, header cleanup

**Reported:** 2026-09-22, by user screenshot — clicking "New chat" produced two identical
"New session" rows in Recents instead of one, plus a request to remove the Stop/Delete buttons
from the session header and rename the sidebar button.

## Bug: duplicate session on create

**Symptom:** Pressing the sidebar's create button added two rows with the same title to Recents.

**Root cause:** `App.tsx`'s `handleCreate` wrote the newly created session into local state itself
(`setSessions((prev) => [session, ...prev])`) *and* `SessionManager.createSession()`
(`src/main/session/session-manager.ts`) separately emits a `"session.update"` IPC event for the
same session, which the renderer already listens to via `useSessionUpdateEvent` and applies with
its own (deduplicating) state update.

The event is sent from inside the `session.create` IPC handler, before the handler function
returns — so it reaches the renderer's `ipcRenderer.on("session.update")` listener before the
`await window.agentBridge.createSession()` call in `handleCreate` resolves. Net effect: the
event-driven update added the session first (no existing entry to dedupe against), then
`handleCreate`'s own unconditional prepend added a second copy of the same session id right after.

**Fix:** `handleCreate` no longer touches `sessions` state at all — it only uses the resolved
session's `id` to select it. The `session.update` event (already deduplicating via
`filter((s) => s.id !== payload.id)` before prepending) is now the single write path for adding a
session to the list, so a duplicate is impossible by construction rather than by timing luck.

**File:** [src/renderer/App.tsx](../src/renderer/App.tsx) — `handleCreate`.

## UI cleanup (explicit request, not a bug)

- Removed the **Stop** and **Delete** buttons from the session header (`App.tsx`), along with the
  now-unused `handleStop`/`handleDelete` callbacks. The backend (`session.stop`/`session.delete`
  IPC handlers, `SessionManager.stopSession`/`deleteSession`) is untouched and still works — there
  is just no UI control wired to it right now. User said they'll revisit this later.
- Renamed the sidebar's create button label from "New chat" to "Session"
  ([src/renderer/SessionList.tsx](../src/renderer/SessionList.tsx)). Behavior unchanged — it still
  creates one session with the default placeholder title ("New session"), same as before.
- Message-thread body (message list + input box) intentionally left untouched per explicit
  instruction — more direction on that is coming later.
