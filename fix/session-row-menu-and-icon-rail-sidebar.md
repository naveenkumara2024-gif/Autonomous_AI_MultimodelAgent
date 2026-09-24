# Fix: per-session hover menu (Edit/Delete), icon-rail sidebar collapse

**Reported:** 2026-09-22, by user screenshot — wants a hover-revealed "⋯" button on each session
row opening an Edit/Delete dropdown (themed to match the rest of the app), the manual sidebar
resize to not be artificially restricted, and collapsing (whether via the top-bar toggle or by
dragging all the way down) to settle at an icon-only rail — just the home and new-session icons —
instead of vanishing to zero width.

## Session row menu (Edit / Delete)

- New shadcn primitive, hand-authored to match the existing ones:
  [src/renderer/components/ui/dropdown-menu.tsx](../src/renderer/components/ui/dropdown-menu.tsx)
  (Radix `DropdownMenu`, `bg-popover`/`text-popover-foreground` — same token system as
  `tooltip.tsx`, so it's visually consistent with the rest of the app, not a one-off style).
- [src/renderer/SessionList.tsx](../src/renderer/SessionList.tsx) — each row is now a `SessionRow`
  subcomponent. Hovering reveals a `MoreHorizontal` icon button (opacity transition, `group-hover`)
  that opens a menu with **Edit** (`Pencil`) and **Delete** (`Trash2`, styled with
  `text-destructive`). The row's title/select button and the menu trigger are siblings, not nested
  buttons — a button-inside-a-button is invalid HTML and was going to bite us in accessibility
  testing eventually if left as a shortcut.
- **Edit** swaps the title into an inline `<input>` (autofocus + select-all via
  `requestAnimationFrame`, `onCloseAutoFocus={(e) => e.preventDefault()}` on the menu content so
  Radix's default "return focus to trigger" behavior doesn't steal focus from the new input).
  Enter or blur commits (only if the trimmed text actually changed and isn't empty — a blank submit
  cancels rather than blanking the title, since `sessions.title` is `NOT NULL`); Escape cancels.
- **Delete** reuses the existing `session.delete` IPC path (unchanged since Stage 1) — this fix
  just gives it a UI trigger again, after it was removed in `fix/new-chat-duplicate-session.md`.
  If the deleted session was the selected one, `App.tsx` clears the selection.
- **New backend capability**: renaming didn't exist as a user-triggered action before (only the
  automatic first-message titling did). Added `SessionManager.renameSession()`
  ([src/main/session/session-manager.ts](../src/main/session/session-manager.ts)), a
  `session.rename` IPC handler, and the matching `preload`/`vite-env.d.ts` bridge entries. Verified
  directly against a temp SQLite DB (same method as the Stage 1 persistence test): trims input,
  rejects a blank rename as a no-op instead of clearing the title, persists correctly, and fires
  `session.update` — all passed.

## Sidebar: drag past the old floor, collapse to an icon rail instead of zero

Previously the sidebar had two disconnected states: a `sidebarOpen` boolean (fully shown or fully
gone) and a `width` number clamped to `[220, 480]px` for when it was open — so manually dragging
could never collapse it, and the toggle button's "collapsed" meant literally 0px.

Reworked as one continuous value in
[src/renderer/hooks/useSidebarWidth.ts](../src/renderer/hooks/useSidebarWidth.ts): width now
ranges continuously from `SIDEBAR_ICON_WIDTH` (60px) up to `SIDEBAR_MAX_WIDTH` (480px) — the old
220px floor is gone, so dragging down doesn't hit an artificial wall before reaching the rail.
Below `SIDEBAR_COLLAPSE_THRESHOLD` (160px) the sidebar is considered collapsed and
`SessionList.tsx` renders an entirely different, purpose-built icon-only layout (`Bot`/home and
`Plus`/new-session buttons, centered) rather than a squeezed, clipped version of the full layout —
a partial view of the search box and title list at 60px would look broken, not clean.

The top bar's toggle button and manual dragging now drive the *same* state: toggling remembers the
width you were at before collapsing (`preferredWidth`, persisted separately in `localStorage`) and
restores exactly that on expand, rather than always resetting to the default.

**Files:** `src/renderer/hooks/useSidebarWidth.ts`, `src/renderer/SessionList.tsx`,
`src/renderer/App.tsx`, `src/renderer/components/TopBar.tsx` (prop renamed `sidebarOpen` →
`sidebarCollapsed` to match the new model — inverted meaning, not just a rename, so every call site
was checked).
