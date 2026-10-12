# Settings UI: bring-your-own model provider (base URL, API key, automation model)

Supersedes `prompts/llm-provider-failover.md` (written, never implemented). You asked for a
settings screen instead of an automatic failover chain; the data model below is an ordered list of
providers with one *active*, so a priority/failover order can be added on top later without
changing it.

## Goal
A clean, professional Settings page in the main window where you choose which model provider the
agent uses and give it a base URL, API key and automation model, instead of editing `.env`. Two
providers are predefined (**OpenRouter** and **Nara Router**), and you can add your own custom
OpenAI-compatible providers. The session-title model is chosen by the system and has no setting.

## Layers touched
Electron main (new `settings/` module, IPC, LLM endpoint resolution), preload, renderer (a Settings
view, a header chip), and the three places that currently read `AGENT_*` / `TITLE_GEN_*` env vars
directly. Supervisor graph, subagents, risk classifier, approval gate, resource locks, overlay and
MCP server are **not** touched.

## Docs consulted
- AGENTS.md §3 (no screenshot leaves the device unredacted; safety over autonomy), §5 (structure:
  `config/`, IPC through `client-event-utils.ts`), §7 (Session contract has `model`), §14.
- `prompts/stage-3-mcp-automation-agent.md` decision 4 (agent model config separate from title gen),
  `prompts/ai-title-generation.md` decision 8 (title model changes only on explicit instruction).
- Electron `safeStorage` (Windows DPAPI, per-user) for the API key at rest.
- OpenAI-compatible API shape: `POST {base}/chat/completions`, `GET {base}/models` -> `{ data: [{ id }] }`.

## Code inspected
- `agent/llm-client.ts` — reads `AGENT_BASE_URL` / `AGENT_API_KEY` from `process.env` on **every**
  call, so an endpoint swap needs no restart; never traces the key.
- `agent/title-generator.ts` — own fetch, reads `TITLE_GEN_BASE_URL/KEY/MODEL`; failure is
  non-fatal (falls back to the truncated title).
- `perception/voice-translator.ts` — own fetch against `AGENT_*`; model passed in
  (`config.voiceTranslationModel`).
- `session/session-manager.ts:109` — a turn runs with `session.model`, a **snapshot copied from
  `config.defaultModel` when the session was created**. Changing the model in Settings would
  therefore do nothing for existing sessions (I hit exactly this when switching to
  `agnes-2.5-flash` earlier and had to rewrite 14 rows by hand).
- `config/config-store.ts` — `config.json`; the same object is shared and read lazily
  (`() => config.x`) for the overlay, screenshots and action-cache toggles, so those apply live.
- `renderer/App.tsx` (single main panel + `SessionList`), `components/TopBar.tsx` (icon buttons),
  `components/ui/{button,input,separator,scroll-area,tooltip,dropdown-menu}.tsx`. There is no
  switch/select/tabs component and no router.
- `preflight.ts` — the `agent-api-key` check reads env directly.

## Decisions / assumptions (flagging for approval)

1. **"nararouter" = the Bynara router you already use (`https://router.bynara.id/v1`).** The Nara
   Router preset ships with that URL and default model `agnes-2.5-flash`; the URL is editable. If
   you meant a different service, only the preset constants change.
2. **Providers.**
   | Preset | Base URL | Default model | System-chosen title model |
   |---|---|---|---|
   | OpenRouter | `https://openrouter.ai/api/v1` | `openrouter/free` | `openrouter/free` |
   | Nara Router | `https://router.bynara.id/v1` | `agnes-2.5-flash` | `nemotron-3-ultra-free` |
   | Custom (any number) | you enter it | you enter it | the automation model |
   Presets can't be deleted; their name is fixed, URL/key/model are editable. Exactly one provider
   is **active**; the agent, the title generator and the voice translator all use it.
3. **Title model: no setting, chosen by the system** (as you asked). It comes from the active
   provider's table row above (for a custom provider there is nothing to pick from, so it reuses the
   automation model). The Settings page shows it read-only so it isn't a surprise. `TITLE_GEN_*` in
   `.env` stays only as a fallback when no provider is configured.
4. **API key storage.** Encrypted with `safeStorage` into `<userData>/providers.json`; only
   non-secret fields are readable on disk. **The key never goes to the renderer**: the page gets
   `hasKey` and the last 4 characters. If `safeStorage` is unavailable the save is refused with a
   message rather than falling back to plaintext.
5. **First run import.** If there is no `providers.json`, `AGENT_BASE_URL` / `AGENT_API_KEY` from
   `.env` are imported once: into the Nara Router preset when the host is `router.bynara.id`,
   otherwise into a custom provider "Imported from .env". It becomes active, so nothing changes for
   you on first launch. `.env` itself is not modified. With no `providers.json` and no env (tests,
   dev), the env vars keep working exactly as today.
6. **The model applies to existing sessions.** A turn's model becomes "the active provider's
   model", resolved when the turn starts; the session row's `model` is updated to match so the
   stored value stays truthful (AGENTS.md §7 keeps `Session.model`). New sessions get it at
   creation as before.
7. **Validation.** Base URL must be `https://`, or `http://` only for `localhost` / `127.0.0.1` /
   `::1` (local servers such as Ollama / LM Studio). Trailing slashes are trimmed; name and model are
   trimmed and length-capped. A key can't be sent to a non-loopback `http://` URL.
8. **Test connection and model browsing (extra features).** In main, so the key stays there:
   - **Test connection**: `GET /models` (if supported) plus a 1-token chat completion with the
     configured model; shows latency and a plain-language result (401 -> "key rejected", 402 ->
     "out of credits", 404 -> "model not found", timeout, DNS...). Works on unsaved edits.
   - **Browse models**: fills a searchable suggestion list from `/models`. Typing any model name by
     hand always works (some routers don't expose `/models`).
9. **Other settings that already exist in `config.json` but have no UI** are surfaced, because they
   make the system easier to operate:
   - Show the live automation overlay; minimize the app window while automating
     (`automationOverlayEnabled`, `automationMinimizeMainWindow`) — apply immediately.
   - Send screenshots to the model (`allowScreenshotsToModel`) — applies immediately; carries a
     one-line note that screenshots go to the active provider.
   - Reuse learned steps / action cache (`actionCacheEnabled`) + a **Clear cache** button
     (the existing `actionCache.clear` handler).
   - Voice language: Auto / Tamil -> English (`voiceLanguage`) — applies after restart (labelled).
10. **Active-model chip in the header** (`agnes-2.5-flash · Nara Router`, or "No provider" when
    nothing is configured) that opens Settings, so the model in use is never a mystery.
11. **UI.** A full-panel Settings view in the main window (state in `App`, no router): gear button in
    the top bar, a Back button, Esc to go back. Single scrolling column (max ~720 px) of section
    cards with the settings-row pattern (label + description left, control right). Provider list as
    selectable cards with an Active pill and a key-saved dot; the selected one opens an inline
    editor (Name for custom, Base URL, API key with show/hide and "saved ending 1a2b",
    Automation model + Browse, Test connection, Save, Set as active, Delete for custom). Reuses
    existing tokens, dark/light themes and `Button`/`Input`; adds a small `Switch` and a styled
    native `<select>`. No new dependencies.
12. **Not doing:** automatic failover between providers (see top; the ordered list makes it a small
    follow-up), per-subagent models, usage/cost tracking, importing/exporting settings, a hotkey
    editor, a title-model setting.

## Safety implications
- **The API key is the sensitive asset.** DPAPI-encrypted at rest, held in main memory only,
  never sent to the renderer, never in a trace row, log line or error message (errors from the test
  call are scrubbed of the key). IPC handlers accept calls **only from the main window** — not the
  voice overlay or the automation overlay, which share the preload bridge.
- **The agent cannot change settings.** No tool exposes them, the handlers reject non-main senders,
  and the MCP click/drag guard already refuses synthetic input aimed at the app's own windows, so
  the agent can't drive the Settings page either.
- **Changing provider changes who sees your screen.** Redaction and the screenshot toggle are
  unchanged and applied upstream of any provider, but whichever provider is active receives the
  (redacted) screenshots and prompts. This is the user's explicit choice; the page says so next to
  the toggle. Pointing at an untrusted URL would leak the key to it, which is why non-loopback
  `http://` is rejected and the URL is shown in full before saving.
- Risk classifier and approval gate semantics are untouched; a different model changes reliability,
  not the gate.

## Files to touch
Create (main):
- `src/main/settings/provider-presets.ts` — preset table, URL/name/model validation (pure).
- `src/main/settings/provider-store.ts` — `providers.json` persistence with an injected cipher
  (real one wraps `safeStorage`), CRUD, active id, public view without keys, env import.
- `src/main/settings/provider-client.ts` — `testProvider`, `listModels` (injected `fetch`).
- `src/main/settings/llm-endpoint.ts` — one place that answers "which base URL / key / model right
  now": active provider when the store is initialised, else the env vars. Used by the three
  callers below.
- `src/main/settings/settings-handlers.ts` — IPC (`settings.get`, `provider.save`,
  `provider.delete`, `provider.setActive`, `provider.test`, `provider.models`, `settings.update`)
  with the main-window sender check.
- Tests: `provider-presets.test.ts`, `provider-store.test.ts` (temp dir + fake cipher: round trip,
  key never in the public view or file, env import, active fallback on delete),
  `provider-client.test.ts` (status mapping, key scrubbing), `llm-endpoint.test.ts` (provider vs env
  precedence).

Create (renderer):
- `src/renderer/SettingsPage.tsx`, `src/renderer/components/settings/{ProviderCard,ProviderEditor,
  SettingRow,SettingsSection}.tsx`, `src/renderer/components/ui/switch.tsx`,
  `src/renderer/hooks/useSettings.ts`.

Modify:
- `agent/llm-client.ts`, `agent/title-generator.ts`, `perception/voice-translator.ts` — read the
  endpoint from `llm-endpoint.ts` (env fallback preserved so the existing tests still pass).
- `session/session-manager.ts` + `session/session-store.ts` — turn uses the active model; `setModel`.
- `main/index.ts` — init the store, register handlers, pass the model resolver.
- `preflight.ts` — the agent check reports the active provider (name, host, key present).
- `preload/index.ts`, `renderer/vite-env.d.ts`, `renderer/types.ts`, `renderer/App.tsx`,
  `renderer/components/TopBar.tsx` — bridge, view switch, gear + model chip.
- `.env.example` — note that provider settings now live in the app; env vars remain a fallback.

## Acceptance criteria
1. Settings opens from the gear, Esc/Back returns to the chat; both themes look correct.
2. First launch after upgrade: Nara Router is active with the key imported from `.env`; the agent,
   titles and voice translation behave as before; no prompt for anything.
3. Entering an OpenRouter key and setting it active makes the **next** turn (in a new *and* an
   existing session) use `openrouter/free`; the trace shows that model; no restart.
4. **Test connection** reports success with latency for a good key, and a specific message for a
   bad key / bad URL / unknown model, without the key appearing anywhere in the message.
5. Adding a custom provider (name, URL, key, model), activating, editing and deleting works; deleting
   the active one falls back to a configured provider (or "No provider" with a clear prompt).
6. After saving, `providers.json` contains no plaintext key and `settings.get` never returns one.
7. `http://` to a non-loopback host is rejected; `http://localhost:11434/v1` is accepted.
8. The title for a new session is generated by the system-chosen model of the active provider; if
   it fails the truncated title remains.
9. Toggles (overlay, minimize, screenshots, action cache) take effect on the next turn; Clear cache
   empties recipes; voice language shows the restart note.
10. Handlers reject calls from the overlay windows (test).
11. `bun run typecheck`, `bun test`, `bun run build` pass with real output reported.

## Manual test steps
1. Launch; confirm the header chip shows `agnes-2.5-flash · Nara Router`.
2. Settings -> OpenRouter: paste a key, Test connection, Browse models, Save, Set as active; send a
   prompt in an existing session; read the model in the trace.
3. Switch back to Nara Router; confirm the next turn uses it.
4. Add a custom provider pointing at a bad URL; Test connection shows a readable failure.
5. Toggle each automation setting; run a task; confirm overlay/screenshot behaviour changes.
6. Restart the app; confirm everything persisted and the key still works.

## Open assumptions (flag if wrong)
- "nararouter" = `router.bynara.id` (decision 1).
- Both routers expose `GET /models` in the OpenAI shape. If one doesn't, Browse models says so and
  free-text entry still works; I will check each with one real request and report the result.
- OpenRouter's `openrouter/free` handles tool calls and images adequately for the agent; reliability
  of whichever free model it picks can't be guaranteed from here, and free tiers are rate-limited.
- Updating each existing session's stored `model` on its next turn is acceptable (decision 6).

## As built: changes to the plan found during implementation

- **No silent `.env` fallback once the app has a provider store.** `settings/llm-endpoint.ts` uses
  the active provider only; with no key it returns null and the agent says "No API key is saved for
  X. Open Settings...". The env vars only apply where no store exists (unit tests, a bare dev run),
  which is also what kept every older test passing unchanged. `TITLE_GEN_*` stays the title
  fallback when the active provider has no key.
- **Voice translation model.** `config.voiceTranslationModel` was written for the Nara catalogue
  (`agnes-3-flash`), so it applies only when Nara Router is active; any other provider translates
  with its own automation model (a Nara model name means nothing on OpenRouter).
- **Handlers return `{ ok, error }` results instead of throwing**, so a validation error reads as a
  sentence in the page rather than an "Error invoking remote method" string. The logic lives in
  `settings-service.ts` (no Electron, unit-tested); `settings-handlers.ts` is only IPC + the
  main-window check + field-by-field input re-shaping.
- **Preflight.** The agent check now reports the provider chosen in Settings
  (`agentProviderCheck`), not the env vars. The provider store is created before preflight.
- **Header.** The top bar no longer repeats "Settings" above the page's own heading.
- **Contrast.** Inputs use `border-foreground/15 bg-background`; the stock `border-input` was
  invisible against the card in dark mode.

### Verified here
| Check | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun test` | 278 pass, 0 fail (224 before; +54: presets/validation, store, client, endpoint, service) |
| `bun run build` | exit 0 (MCP exe, Vite, electron-builder NSIS) |
| Real renderer in headless Chrome with a stubbed bridge, both themes | Settings opens from the gear; provider selection, new-custom form, Test (success box), Browse (filter list) and toggle round-trip render and work; zero page errors; screenshots reviewed |
| `GET /models` on both routers (one real request each) | Nara Router: 200, 48 models, includes `agnes-2.5-flash`. OpenRouter: 200, 459 models, includes `openrouter/free` |
| Electron `safeStorage` on this machine | available; encrypt/decrypt round-trip OK; ciphertext does not contain the plaintext |

### Not verified (needs you)
- A real agent turn after switching provider in the running app, and the first-launch `.env`
  import (it happens the next time the app starts; `providers.json` does not exist yet).
- **Test connection against OpenRouter with a real key** (no OpenRouter key exists yet, so only the
  listing endpoint was exercised), and whether `openrouter/free` handles this agent's tool calls
  and screenshots well enough.
- The Settings page was exercised through a stubbed bridge, not through Electron IPC end to end.
