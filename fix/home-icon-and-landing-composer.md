# Fix: home icon above Session button, Gemini-style landing composer

**Reported:** 2026-09-22, by user screenshot of Gemini's default/no-chat screen — asked for (1) an
icon above the "Session" button that returns to the default body view, and (2) the default body
view itself (shown when no session is selected) to follow that same shape: centered greeting +
a message composer, not just static text — with the explicit note that the design doesn't need to
resemble Gemini's, only the structure, and that swapping in a background image for that screen
later must be simple.

## Home icon

Added a placeholder icon button (`Bot` from `lucide-react` — "any icon for now" per the request,
swap freely later) above the "Session" button in
[src/renderer/SessionList.tsx](../src/renderer/SessionList.tsx). Clicking it calls a new `onHome`
prop, which `App.tsx` wires to `setSelectedId(null)` — the same state that already drives the
idle/landing view, so no new "view mode" concept was introduced.

## Landing view becomes a real composer, not decoration

The previous idle state was a static "Hey There" with nothing else. Structurally matching the
Gemini reference means the landing screen doubles as how you start a session — you type there, you
don't have to click "Session" first. Built that as real behavior, not a decorative input that goes
nowhere:

`handleLandingSubmit` in [src/renderer/App.tsx](../src/renderer/App.tsx) calls
`createSession()` then `continueSession()` with the typed text, then selects the new session —
reusing the same event-driven state update path `handleCreate` already uses (see
`fix/new-chat-duplicate-session.md`): it does **not** manually push into `sessions` or `messages`;
the existing `session.update` event and the `listMessages` effect (keyed on `selectedId`) pick it
up, so this couldn't reintroduce the earlier duplicate-row bug.

Deliberately **not** added: attach/mic/model-selector icons from the Gemini reference. Those map to
features that don't exist yet (file attach, voice input, model switching) — a decorative icon that
does nothing would be a half-finished implementation, not a placeholder like the home icon (which
does have a real destination). The composer is just a text input + send button, both functional.

## Swappable background

[src/renderer/lib/hero-background.ts](../src/renderer/lib/hero-background.ts) exports a single
`HERO_BACKGROUND_IMAGE` constant (currently `undefined`). The landing view reads it once and
applies it as a CSS `background-image` if set. Adding an image later is: drop the file under
`src/renderer/assets/`, import it, assign it to that one export — nothing else in the app touches
the image path, so there's no other place to update.

**Files:** `src/renderer/App.tsx`, `src/renderer/SessionList.tsx`,
`src/renderer/lib/hero-background.ts`.
