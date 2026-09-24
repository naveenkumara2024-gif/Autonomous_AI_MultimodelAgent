# UI shell redesign — shadcn neutral theme, top bar + sidebar rebuild

## Goal
Rebuild the renderer's outer chrome (top bar, sidebar, idle body state) to match the layout
language of the reference screenshot the user shared (clean neutral SaaS shell — slim top bar,
icon+label sidebar nav, soft cards, colored status dots), on a real light/dark theme pair that
won't break the next time the theme is touched. Does not touch the message-thread view inside an
open session (input box, message bubbles) — that's Stage 1 functionality, out of scope here.

## Layers touched
`src/renderer/` only. No main-process, IPC, or session-logic changes.

## Reference material
- User-supplied screenshot: a "Code" workspace shell (unrelated product, "Axiom Ultra" branded) —
  used for layout/structure/component-style reference only, not for literal colors or copy.
- shadcn/ui theming docs, fetched live: confirmed shadcn's *current* default theme uses OKLCH
  variables (Tailwind v4 convention). This repo is pinned to Tailwind v3 (`"tailwindcss": "^3"`
  since Stage 0), so this stage uses shadcn's long-standing **v3-compatible HSL variable
  convention** instead (`--background: 0 0% 100%;` consumed as `hsl(var(--background))` in
  `tailwind.config.js`) — the same convention shadcn shipped for years before v4, still fully
  supported, and the only one that matches our installed Tailwind major version. Upgrading to
  Tailwind v4 is out of scope for a UI redesign ask and not requested.

## Decisions / assumptions (already confirmed with the user)
1. **Neutral palette, not the existing purple/HUD accent.** Asked directly: keep the Stage 1
   purple brand color, or switch to a neutral gray palette closer to the screenshot. User chose
   neutral. This retires `tailwind.config.js`'s bespoke `base/ink/accent/panel/chip/control` token
   set from Stage 0 entirely — an intentional reversal of that earlier choice, not scope creep.
2. **shadcn's standard "Neutral" HSL theme** (the well-known, unchanged-for-years default) is the
   base for both light and dark — not invented from scratch, not a literal clone of the
   screenshot's warm peach gradient (that's specific branding of the unrelated reference product).
   Status dots (session status: created/idle/running/stopped) keep their own semantic colors
   (gray/green/blue/amber) independent of the neutral brand tokens, so they read clearly in both
   themes.
3. **Components are hand-authored to shadcn's canonical source, not fetched via the `shadcn` CLI.**
   The CLI's `init`/`add` commands are interactive and can overwrite `tailwind.config.js`/
   `index.css` in ways I can't fully predict in this environment — given the user's explicit "don't
   mess things up" concern, hand-authoring the same small set of files (`button.tsx`, `input.tsx`,
   `separator.tsx`, `scroll-area.tsx`, `tooltip.tsx`) gives full control over exactly how they wire
   into our existing Vite/Electron setup, while still being byte-for-byte the same component code
   the CLI would generate.
4. **Top bar = theme toggle only.** Per instructions: no mode tabs (Chats/Colab/Code equivalent),
   no back/forward chevrons, no sidebar collapse/expand toggle, no macOS traffic-light dots (moot
   anyway — [[project-windows-only-scope]]). Single icon button (Sun/Moon, lucide-react) that
   flips the theme.
5. **Sidebar = New chat, Search, Recents only.** Drops the screenshot's Customize entry and its
   Chats/Projects/Tasks/Agents/Companies nav block entirely — "chat" in the user's request maps
   1:1 to our existing `Session` concept, there's no separate nav needed. Search is a real,
   working client-side filter over the loaded session list by title substring — not decorative.
   No profile/account section — no auth exists or is planned yet; noted below as a future item,
   not built now.
6. **Idle body state shows a centered "Hey There" greeting**, replacing the current "Select or
   create a session to get started" placeholder. Reading of "leave it empty" = the *idle* landing
   state stays minimal (just the greeting), not that the working message-thread view (already
   built and tested in Stage 1) gets removed when a session is open.
7. **Theme persistence**: `localStorage`, defaulting to the OS `prefers-color-scheme` on first run
   if nothing is stored yet — standard, no server round-trip needed for a per-viewer UI
   preference.
8. **New dependencies** (all standard shadcn/ui companions): `@radix-ui/react-tooltip`,
   `@radix-ui/react-scroll-area`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`,
   `tailwind-merge`, `tailwindcss-animate`, `lucide-react`.

## Files to touch
Create:
- `components.json` — hand-written shadcn config (style: "new-york", baseColor: "neutral",
  cssVariables: true), so a future `shadcn add <component>` run (if ever used) matches this setup
  instead of guessing at conventions.
- `src/renderer/lib/utils.ts` — the standard `cn()` helper (`clsx` + `tailwind-merge`).
- `src/renderer/components/ui/button.tsx`, `input.tsx`, `separator.tsx`, `scroll-area.tsx`,
  `tooltip.tsx` — shadcn canonical source, hand-authored per decision 3.
- `src/renderer/components/TopBar.tsx` — theme toggle only.
- `src/renderer/hooks/useTheme.ts` — light/dark state, `localStorage` + `prefers-color-scheme`
  default, applies `.dark` class to `<html>`.

Modify (rewritten, not incrementally patched):
- `tailwind.config.js` — shadcn v3 token mapping (`background/foreground/card/popover/primary/
  secondary/muted/accent/destructive/border/input/ring`, `borderRadius` off `--radius`), plus
  `tailwindcss-animate` plugin. Drops Stage 0's bespoke palette per decision 1.
- `src/renderer/index.css` — `:root`/`.dark` HSL variable blocks, `@layer base` border/background
  defaults.
- `src/renderer/SessionList.tsx` — becomes the sidebar: New chat row, Search input (live filter),
  "Recents" label, session rows with status dot + title, using the new `ui/` primitives.
- `src/renderer/App.tsx` — composes `TopBar` + `SessionList` + main pane; idle state renders "Hey
  There"; existing message-thread/input logic kept, restyled with the new `Button`/`Input`
  primitives where it's a drop-in swap, not restructured.
- `src/renderer/types.ts` — no shape changes expected, touched only if a status-color mapping
  needs a shared type.
- `package.json` — new devDependencies listed above.

Not touched: any `src/main/` file, IPC contract, session logic, `dev:web` wiring.

## Safety implications
None — renderer-only visual/UX change, no new IPC surface, no new filesystem/network access
beyond the new npm packages themselves.

## Acceptance criteria
1. Top bar shows only a working theme toggle; no tabs, arrows, or collapse button anywhere.
2. Sidebar shows New chat, a working Search box that filters the session list as you type,
   "Recents" label, and the session list with status dots — no Customize, no nav block, no profile
   section.
3. No selected session → main pane shows a centered "Hey There" and nothing else.
4. Selecting/creating/messaging a session still works exactly as in Stage 1 (this stage doesn't
   touch that logic).
5. Toggling the theme button flips every surface (background, text, borders, sidebar, buttons)
   consistently between light and dark — no element stuck in the old palette.
6. Reload the app → theme choice persisted.
7. `bun run typecheck` clean, `bun run build` succeeds.

## Manual test steps
1. `bun run dev`.
2. Confirm top bar has nothing but the toggle; click it, confirm the whole UI flips light/dark.
3. Type in Search, confirm the session list filters live; clear it, confirm the full list returns.
4. Create a session via "New chat", confirm it appears in Recents and behaves as before (message
   send/receive-echo, stop, delete — unchanged from Stage 1).
5. With no session selected, confirm the body just shows "Hey There", centered, no other chrome.
6. Reload the app (`bun run dev` again), confirm the theme choice you left it on persisted.
