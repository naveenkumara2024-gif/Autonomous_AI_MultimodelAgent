# Fix: gap between icon-rail content and sidebar edge while resizing

**Reported:** 2026-09-22, by user screenshot — dragging the sidebar narrower made the text
disappear (switching to icon-only mode) while the sidebar itself was still much wider than the
icons needed, leaving a large empty gap between the window edge and the icons.

## Root cause

[src/renderer/hooks/useSidebarWidth.ts](../src/renderer/hooks/useSidebarWidth.ts)'s `clamp()`
only enforced the outer floor/ceiling (`[SIDEBAR_ICON_WIDTH, SIDEBAR_MAX_WIDTH]` = `[60, 480]`).
`SessionList.tsx` separately decides whether to render icon-only content based on
`width <= SIDEBAR_COLLAPSE_THRESHOLD` (160). Since dragging can stop at *any* value in between —
say the user releases at 130px — the sidebar's actual CSS width sat at 130px while its content
switched to the icon-only layout, which centers a couple of 36px buttons inside whatever width the
container has. Centered inside 130px instead of the intended 60px, that's the gap in the
screenshot.

## Fix

`clamp()` now snaps anything at or below `SIDEBAR_COLLAPSE_THRESHOLD` straight to
`SIDEBAR_ICON_WIDTH`, closing the dead zone entirely — a width can only ever be exactly 60px or
something above 160px, never a value in between. Verified directly: ran the clamp logic against a
sweep of inputs (0 through 600) and asserted no output ever lands in `(60, 160]`; all passed.
Practically: drag past the threshold and the sidebar snaps straight to the icon rail in one step
instead of drifting to wherever the cursor happened to stop.

**File:** `src/renderer/hooks/useSidebarWidth.ts` — `clamp()`.
