# Stage 0 — Electron scaffold conversion

## Goal
Replace the current Bun-script stub (`src/index.ts` logging "Hello via Bun!") with a real
Electron `main/preload/renderer` split per AGENTS.md section 5. No agent, session, perception,
or safety logic — purely the process skeleton every later stage plugs into, plus one deliberate
end-to-end smoke test (an IPC round trip) proving the split actually works rather than just
existing on disk.

## Layers touched
Process/build skeleton only: `main/`, `preload/`, `renderer/` top-level files, build tooling
(Vite, electron-builder, TypeScript project config). No `agent/`, `session/`, `sandbox/`,
`perception/`, `mcp/`, `skills/`, `tools/`, `memory/`, `db/` — those are later stages and would
be empty/fake right now.

## Docs consulted
- AGENTS.md/CLAUDE.md section 5 (target file tree) and section 4 (Electron docs: `contextBridge`,
  never `nodeIntegration`).
- Open Cowork (`OpenCoworkAI/open-cowork`) — fetched live to confirm actual conventions rather
  than assume them:
  - `src/main/` contains flat files `index.ts`, `client-event-utils.ts`, `nav-server.ts`,
    `preflight.ts`, `workspace-path-constraints.ts` alongside the domain folders — confirms
    section 5's tree is a faithful translation, not a guess.
  - `src/preload/` is a single `index.ts`.
  - Build stack: `vite-plugin-electron` with two entries — `src/main/index.ts` → `dist-electron/main`,
    `src/preload/index.ts` → `dist-electron/preload` — plus `electron-builder` for packaging,
    Node ≥22, path aliases `@`/`@main`/`@renderer`.

## Code inspected
- `package.json` — currently Bun-only (`bun run src/index.ts`), `type: module`, no Electron/Vite/React deps yet. `bun.lock` present, so Bun stays the package manager/script runner (Electron's own bundled Node runs the actual main process — that's orthogonal to which tool installs packages and runs scripts).
- `tsconfig.json` — single config, `types: ["bun"]`, `jsx: "react-jsx"` already set, `lib: ["ESNext"]` (no DOM). This already assumes React is coming.
- `tailwind.config.js` — fully themed already (dark HUD palette, `panel`/`chip`/`control` radii, glow shadows) with `content: ["./src/**/*.{html,js,ts,jsx,tsx,...}"]`. This is clearly pre-built for `OverlayWindow`/`ApprovalDialog`/`TracePanel` — confirms renderer = React + Tailwind, not a fresh design decision.
- `postcss.config.cjs` exists, wired for Tailwind already.
- No existing `vite.config.ts`, `electron-builder` config, or `prompts/` content before this file.

## Decisions / assumptions (flagging for approval)
1. **Renderer = React + TypeScript + Tailwind.** Inferred from existing `tsconfig.json`
   (`jsx: react-jsx`) and the fully-built `tailwind.config.js` — not introducing a new framework
   choice, just wiring what's already configured.
2. **Package manager stays Bun** (`bun install`/`bun run`), matching existing `bun.lock`.
   Electron's main process runs under Electron's bundled Node regardless of which tool built it.
3. **Build tool = `vite-plugin-electron`**, mirroring Open Cowork's confirmed setup, not the
   alternative `electron-vite` tool — staying faithful to the named reference project rather than
   substituting a different (also popular) tool that produces a similar-looking tree.
4. **TypeScript project split** into `tsconfig.json` (references-only root) +
   `tsconfig.node.json` (main + preload, Node lib, no DOM) + `tsconfig.app.json` (renderer, DOM
   lib, `vite/client` types) — the standard Vite+TS multi-target pattern, needed because main and
   renderer have genuinely incompatible global type environments (Node vs DOM).
5. **One real IPC round trip, not zero.** A silent shell with no working IPC can't actually be
   manually tested — you'd be trusting that `contextBridge` wiring works without ever exercising
   it. Scope: preload exposes exactly one method, `getAppVersion()`; main registers exactly one
   handler for it via `client-event-utils.ts`; renderer displays the result. Nothing beyond this
   touches the filesystem, network, or native input — that boundary is intentional, see Safety
   below.
6. **`preflight.ts` is a real function shape with no real checks yet.** It runs at startup, logs
   that no checks are configured, and returns a typed `PreflightResult` with an empty `checks: []`
   — it must not claim WSL2/Lima, API keys, or hotkey-availability were verified when they weren't.
   Real checks get added stage-by-stage as the things they check for (sandbox, perception, config)
   get built.
7. **`workspace-path-constraints.ts` is a typed stub, not real logic.** Its real job (path-guard
   fallback) has no consumer until `tools/tool-executor.ts` exists (Stage 3). Building real logic
   now with nothing calling it risks silent drift from what Stage 3 actually needs. File exists
   with the right exported shape (`assertPathAllowed(root, target): void`) throwing
   `"not implemented"` so any accidental early caller fails loudly instead of silently no-op'ing.
8. **`electron-builder` config is minimal and honestly incomplete.** App id/product name +
   `dist-electron`+`dist` as build inputs, NSIS target for Windows (dev machine is Windows) only.
   No icons, no code signing, no mac/linux targets yet — flagged as a follow-up, not silently
   faked with placeholder assets.

## Files to touch
Create:
- `vite.config.ts`
- `electron-builder.json5`
- `tsconfig.node.json`, `tsconfig.app.json` (rewrite `tsconfig.json` to reference-only)
- `src/main/index.ts`
- `src/main/preflight.ts`
- `src/main/workspace-path-constraints.ts`
- `src/main/client-event-utils.ts`
- `src/main/nav-server.ts`
- `src/preload/index.ts`
- `src/renderer/index.html`
- `src/renderer/main.tsx`
- `src/renderer/App.tsx`
- `src/renderer/vite-env.d.ts`

Modify:
- `package.json` (scripts + deps: `electron`, `electron-builder`, `vite`, `vite-plugin-electron`,
  `@vitejs/plugin-react`, `react`, `react-dom`, `typescript`, `@types/node`, `@types/react`,
  `@types/react-dom`)
- `.gitignore` (add `dist/`, `dist-electron/`, `release/`)

Delete:
- `src/index.ts` (superseded by `src/main/index.ts`)

Not touched: `agent/`, `session/`, `sandbox/`, `perception/`, `mcp/`, `skills/`, `tools/`,
`memory/`, `db/`, `config/` — creating empty placeholder folders for logic that doesn't exist yet
is exactly the "half-finished implementation" AGENTS.md says not to do.

## Safety implications
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on the `BrowserWindow` —
  this is the enforceable boundary at this stage, verified manually (see below).
- No `ipcMain` handler beyond `app:getVersion` exists yet. Nothing here touches the filesystem,
  spawns processes, or reaches the network, so `risk-classifier.ts`/`approval-gate.ts` correctly
  don't exist yet — Stage 0 must not grow a handler that does anything destructive before Stage 2
  (sandbox skeleton) exists to gate it.
- `preflight.ts` must never report a check as passed that it didn't actually run.

## Acceptance criteria
1. `bun install` succeeds.
2. `bun run dev` opens an Electron window loading the Vite dev server with HMR; window shows a
   placeholder page displaying the app version fetched via the `getAppVersion` IPC round trip.
3. DevTools console in the renderer: `window.require` is `undefined` and `window.electron` (or
   equivalent bridge) exposes only `getAppVersion` — nothing else.
4. `bun run typecheck` passes (both `tsconfig.node.json` and `tsconfig.app.json`).
5. `bun run build` completes: Vite builds the renderer, `vite-plugin-electron` builds
   main+preload, `electron-builder` produces a Windows package without erroring.
6. Startup log shows `preflight` ran and reported zero checks configured (not a fake pass).

## Manual test steps
1. `bun install`
2. `bun run dev` — confirm window opens, shows version string, no console errors.
3. Open DevTools → Console → type `window.require` → confirm `undefined`.
4. Close the app, run `bun run typecheck` — confirm clean exit.
5. Run `bun run build` — confirm `release/` (or configured output dir) contains a built installer,
   inspect logs for errors/warnings.
6. Check terminal output from step 2 for the preflight log line.
