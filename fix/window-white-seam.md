# Fix: stray white line between the menu bar and app content

**Reported:** 2026-09-23, by user screenshot — in dark mode, a thin white horizontal line sat
between the native "File Edit View Window" menu bar and the app's own dark content, right where
the OS chrome meets the web page.

## Root cause

`BrowserWindow` was created in [src/main/index.ts](../src/main/index.ts) without a
`backgroundColor`, so it defaulted to Electron's own default (white). At non-100% display scaling
(this machine runs at 125%), Chromium's compositor can briefly show that underlying window color
through wherever the page's own paint doesn't land pixel-exactly on the frame boundary — most
visibly right under the menu bar. In light mode this is invisible (white-on-white), which is why
it only showed up once dark mode was in use.

## Fix

Set `backgroundColor` on the `BrowserWindow` to match the renderer's actual starting theme:
`nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff"` — the same light/dark values
`index.css`'s `--background` uses, and the same OS-preference default `useTheme.ts` falls back to
on first paint (before anything is in `localStorage`). Verified by rebuilding
(`bun run build`) and running the packaged `release/win-unpacked` exe: the seam is gone, the menu
bar now meets the dark content with no visible line.

**File:** `src/main/index.ts` — `createWindow()`'s `BrowserWindow` options.

**Known gap:** if a user has previously toggled the in-app theme away from their OS preference,
the very first paint on next launch can still show a one-frame mismatch (window background picks
OS preference; the page then applies the stored override) — same class of artifact, just no
longer the default case. Not worth wiring an IPC round-trip for a single frame; revisit only if it
turns out to be visible in practice.
