# Fix: manually resizable sidebar

**Reported:** 2026-09-22 — the sidebar only had the collapse/expand toggle from a previous fix;
user wants to manually drag it wider/narrower too, and for the interaction to feel smooth.

## What changed

- [src/renderer/hooks/useSidebarWidth.ts](../src/renderer/hooks/useSidebarWidth.ts) — new hook,
  same shape as `useTheme.ts`: width state persisted to `localStorage`, clamped to
  `[SIDEBAR_MIN_WIDTH=220, SIDEBAR_MAX_WIDTH=480]`, default `256` (unchanged from the old fixed
  `w-64`, so existing users see no jump).
- [src/renderer/SessionList.tsx](../src/renderer/SessionList.tsx) — the sidebar takes `width` and
  `onWidthChange` props now instead of a hardcoded `w-64`. A thin drag handle sits on the right
  edge (`role="separator"`, 8px hit area so it's easy to grab, 1px visible line that highlights on
  hover/drag via `group-hover`) using pointer events (`pointerdown` on the handle, then
  window-level `pointermove`/`pointerup` while dragging, both removed on release).
- [src/renderer/App.tsx](../src/renderer/App.tsx) — wires `useSidebarWidth()` into `SessionList`
  alongside the existing `sidebarOpen` boolean. Collapse (via the top bar toggle) and resize (via
  the drag handle) are separate concerns: `open` decides whether the sidebar shows at all, `width`
  decides how wide it is when it does.

## The "smooth" part

The sidebar's CSS width transition (used for the collapse/expand toggle) is turned **off** while
actively dragging (`isResizing` state) and back **on** once you release — dragging with the
transition still active makes the sidebar visibly lag a frame behind the cursor, since Tailwind's
`transition-[width]` fights the rapid per-pointer-move width updates. Toggling the transition off
during drag and back on after makes both interactions — the collapse animation and the manual
resize — feel like separate, correctly-paced motions instead of one janky compromise.
