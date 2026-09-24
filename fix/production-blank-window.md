# Fix: packaged installer opens a blank white window

**Reported:** 2026-09-23, by user screenshot — running the built/installed app (not `bun run dev`)
showed only the OS title bar and menu, with a blank white page underneath instead of the app.

## Root cause

[src/main/nav-server.ts](../src/main/nav-server.ts)'s production path loaded
`path.join(__dirname, "../renderer/index.html")`. `__dirname` there resolves to
`dist-electron/main/` (this file's own build output location), so that path pointed at
`dist-electron/renderer/index.html` — a directory that has never existed. The renderer actually
builds to `<root>/dist/index.html` (`vite.config.ts`'s `build.outDir`), two levels up from
`dist-electron/main/`, not one. `win.loadFile()` failed silently against the wrong path, so the
window never got any HTML/JS to render — hence blank white, no console error visible without
opening DevTools.

This only showed up in the packaged/production build: `bun run dev` never hits this code path,
since it loads straight from the Vite dev server URL instead (`nav-server.ts`'s `devServerUrl`
branch), which is why the bug wasn't caught until an actual installer was run.

## Fix

Changed the path to `path.join(__dirname, "../../dist/index.html")`. Verified by running
`bun run build` (produces `release/win-unpacked/Autonomous AI Desktop Agent.exe`) and launching
that exe directly with `--remote-debugging-port` to inspect it via CDP: `document.getElementById
('root')` now has a mounted child and the full UI (sidebar, sessions, theme) renders correctly
instead of an empty `<div id="root">`.

**File:** `src/main/nav-server.ts` — `loadRenderer()`'s production `loadFile` path.
