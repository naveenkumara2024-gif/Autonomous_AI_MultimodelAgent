# Fix: session title text overflowing past the sidebar edge when resized narrow

**Reported:** 2026-09-23, by user screenshot — dragging the sidebar narrower didn't truncate long
session titles; the text ran straight past the resize handle into the main content area instead of
ellipsizing.

## Root cause

[src/renderer/components/ui/scroll-area.tsx](../src/renderer/components/ui/scroll-area.tsx) wraps
the session list in Radix's `ScrollArea.Viewport`. Radix internally wraps its children in its own
extra `<div>` styled `display: table; min-width: 100%` (used to measure content size for the
scrollbar). A `display: table` box sizes to its content's natural width, not its container's — so
that wrapper grew to fit the full unbroken title text and dragged the whole sidebar's rendered
content wider than the actual (narrower) container, defeating `truncate` on
`SessionRow`'s title button (`SessionList.tsx`) even though that button already had the correct
`min-w-0 flex-1 truncate` classes.

## Fix

Forced Radix's auto-generated wrapper div back to `display: block` via
`[&>div]:!block` on the `Viewport`'s className. A block box fills its container's actual width
instead of its content's, so the row's flex layout is bounded correctly again and `truncate`
ellipsizes as expected. Verified by setting `sidebar-width` to 190px and sending a message with a
long title ("What can you help me with today and going forward") — it now renders as
"What can you h…" clipped inside the sidebar instead of overflowing past the divider.

**File:** `src/renderer/components/ui/scroll-area.tsx` — `ScrollArea`'s `Viewport` className.
