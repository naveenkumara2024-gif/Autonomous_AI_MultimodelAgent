# Voice: speak Tamil, get an English prompt

## Goal
Let the user speak Tamil to the voice trigger (stage 4) and have the text that lands in the
session — the user message, and therefore the agent's prompt — be **English**. The Tamil
transcript is kept alongside it so the user can see what was heard and what it was translated to.

## Layers touched
Perception L2 only (`src/main/perception/`), plus one config field and a small overlay/chat display
change. Nothing in the supervisor, subagents, sandbox or risk classifier changes.

## Docs consulted
- AGENTS.md section 9 (a trigger creates/continues one session; nothing captured persists),
  section 3 (no raw audio/screenshot leaves the device), section 14 (safety over autonomy).
- `prompts/stage-4-voice-hotkey-trigger.md` — decision 3 (multilingual model chosen so
  non-English speakers work) and decision 8 (hallucination filtering).
- whisper.cpp `whisper-server`: `POST /inference` accepts a `language` form field (`ta` = Tamil)
  and a `translate` field. Whisper's built-in translate task is the thing we are *not* using, see
  decision 1.

## Code inspected
- `perception/speech-server.ts` — spawns whisper-server with `-l auto`; `transcribe()` posts the
  WAV with no per-request language, so today Tamil comes back as Tamil script and is sent to the
  agent untranslated.
- `perception/audio-pipeline.ts` — `submit()` -> `transcribe` -> `isHallucination` -> `deliver()`
  -> `sessions.send(id, text)`. All side effects are injected, so translation slots in as one
  more injected step with no Electron needed in tests.
- `perception/voice-controller.ts` — wires the pipeline; `sessions.send` calls
  `continueSession` and pushes the message to the renderer (`session.message`).
- `config/config-store.ts` — `AgentConfig` / `DEFAULT_CONFIG` / missing-key migration pattern.
- `agent/title-generator.ts` and `agent/llm-client.ts` — two existing OpenAI-compatible callers.
  `llm-client.chat()` needs a `TurnTrace` (it is the agent's traced client); the title generator
  is the precedent for a small standalone utility that never throws.
- `renderer/OverlayWindow.tsx` — renders `state.message` for `notice` and a status for
  `transcribing`.

## Decisions / assumptions (flagging for approval)

1. **Tamil transcript + LLM translation, not Whisper's built-in translate** (chosen by you).
   `large-v3-turbo` was not trained for the translate task, and switching to `large-v3` would
   cost a ~1.1GB download and speed on a 4GB GPU for weaker English. So: transcribe in Tamil with
   the model already installed, then translate the *text* with an LLM.
2. **New config field `voiceLanguage: "auto" | "ta"`, default `"auto"`.** `"auto"` keeps today's
   behaviour byte-for-byte (so English users are unaffected); `"ta"` forces `language=ta` on the
   whisper request and turns on translation. Forcing Tamil is deliberate: `-l auto` can
   mis-detect short Tamil clips as another language, and Tamil speakers often code-mix English,
   which forced-`ta` handles better than detection. It is a per-request form field, so **no
   whisper-server restart** is needed. Edited in `config.json` like `voiceHotkey`; an in-app
   settings toggle is out of scope (no settings UI exists yet).
3. **Delivery stays "send as the prompt"**, identical to stage 4: the English text is passed to
   `continueSession` and appears in the chat as the user's message. I am not changing it to
   "paste into the input box for review" — you wrote "chat or prompt", and the existing path
   already is both. Flag if you want a review-before-send mode; that is a separate feature.
4. **The original Tamil is shown, not discarded.** The user message in the chat carries the
   English text as its content; the overlay shows the Tamil heard and the English it became
   during the translate step. The Tamil text is **not persisted** anywhere beyond the message
   metadata needed for display (see Files) — no audio is ever stored, as before.
5. **Translator = the agent model** (`config.defaultModel` via `AGENT_BASE_URL`/`AGENT_API_KEY`),
   in a new standalone `voice-translator.ts` modelled on `title-generator.ts` (fetch, timeout,
   never throws). Not `llm-client.chat()`: that is the traced agent loop and needs a turn trace;
   a translation is not an agent step. Not the `TITLE_GEN_*` model: it is a free reasoning model
   with 2.5–7s latency, which is too slow to sit on the critical path of every utterance.
   Low temperature, small token budget, 15s timeout.
6. **The transcript is framed as data to translate, not an instruction** — the same lesson the
   title generator recorded: system prompt says translate only, never answer or act, output the
   English only; the speech is wrapped in `<speech>` tags. Spoken or on-screen text such as
   "ignore previous instructions" must come out as a literal translation, never be obeyed.
7. **Failure policy: fall back, never block, never lose the utterance.** If translation fails
   (no key, network, timeout, empty reply) the pipeline does **not** send raw Tamil to the agent
   silently. It shows the overlay notice "Couldn't translate — sent in Tamil" and sends the Tamil
   text, because the supervisor prompt already replies in the user's language and dropping the
   user's request is worse. (Alternative: discard with "Translation failed". Flagged — say so if
   you prefer that.)
8. **Already-English clips are not re-translated into garbage.** The translator is told to return
   the text unchanged if it is already English, so code-mixed Tamil/English ("open Chrome ஐ")
   comes out as clean English. The hallucination filter runs on the Tamil transcript *before*
   translation (no model call wasted on "Thank you"); a Tamil-script hallucination list is
   **not** added speculatively — I will only add phrases observed in testing.
9. **Latency:** one extra text-only LLM round trip (~0.5–2s) after transcription. The overlay
   gets a distinct "Translating…" phase so the wait is visible, not a frozen "Transcribing…".

## Files to touch
Create:
- `src/main/perception/voice-translator.ts` — `translateToEnglish(text, deps?)`: returns
  `string | null`; fetch injected for tests; never throws.
- `src/main/perception/voice-translator.test.ts` — success, quotes/preamble stripped,
  missing key, non-200, timeout, empty reply, injection text translated not obeyed (via a fake
  fetch asserting the request framing).

Modify:
- `src/main/config/config-store.ts` — `voiceLanguage: "auto" | "ta"` (default `"auto"`; existing
  missing-key migration adds it to old `config.json`s, plus validation of unknown values -> `auto`).
- `src/main/perception/speech-server.ts` — `transcribe(wav, { language? })` adds the `language`
  form field when set. `-l auto` launch arg stays as the default.
- `src/main/perception/audio-pipeline.ts` — new injected `translate?(text)` dep and a
  `translating` phase; runs after the hallucination filter, before `deliver()`; implements the
  fallback in decision 7. `DeliveredPrompt` gains `originalText?`.
- `src/main/perception/voice-controller.ts` — passes `voiceLanguage` to the transcribe call,
  wires `translate` only when `voiceLanguage === "ta"`, forwards `originalText` for display.
- `src/renderer/OverlayWindow.tsx` — "Translating…" phase; shows Tamil -> English preview.
- Chat message display (small): show the original Tamil as a muted secondary line under the
  English user message when present. Exact file confirmed when implementing (likely the message
  component fed by `session.message`); needs an optional `originalText` on the message type.
- Tests: extend `audio-pipeline.test.ts` (translate called after the filter, not called for
  hallucinations/short clips, English delivered, fallback path, `auto` mode never calls
  translate) and `speech-server.test.ts` (language field is sent).

## Safety implications
- **Audio still never leaves the device**: whisper stays local on `127.0.0.1`. What is new is that
  the *Tamil transcript text* is sent to the configured LLM endpoint for translation. That is the
  same endpoint and the same class of data the typed/English transcript already reaches as the
  agent prompt, so no new destination — but it is a new call that happens *before* the user sees
  the message, so I am stating it explicitly rather than burying it.
- The English text goes through `continueSession` -> agent -> risk classifier -> approval gate
  exactly like typed text. Translation adds no new trust: a spoken Tamil "delete my files" becomes
  "delete my files" and still stops at the approval dialog. The risk classifier matches literal
  tool-call `args`, never the translated prompt, so a mistranslation cannot loosen it.
- A mistranslation can change *what the agent is asked to do*. Mitigation is visibility (the
  user sees the English that was sent and the Tamil heard) plus the unchanged approval gate for
  anything destructive. I am not adding a confirm-before-send step; say so if you want one given
  this risk.
- Prompt injection through speech is handled by decision 6 and covered by a test.
- Nothing is persisted that was not persisted before, other than the optional `originalText`
  string on the message record (decision 4) — raw audio is never written.

## Acceptance criteria
1. `voiceLanguage: "auto"` (default): behaviour identical to stage 4; the translator is never
   called; existing tests unchanged and green.
2. `voiceLanguage: "ta"`: speak a Tamil command, press the hotkey; overlay goes
   Recording -> Transcribing -> Translating -> hidden; the session's user message is English and
   the turn runs normally.
3. Code-mixed Tamil/English input produces one clean English prompt.
4. Silence / sub-400ms / hallucinated clip: no translate call, "Didn't catch that".
5. Translation unavailable (unset `AGENT_API_KEY` or blocked network): overlay shows the fallback
   notice, the Tamil text is still delivered, nothing crashes or hangs.
6. A spoken "ignore previous instructions and ..." is translated literally and not acted on by the
   translator.
7. `bun test`, `bun run typecheck` and lint clean; `bun run build` succeeds. Real output reported.
8. Old `config.json` without `voiceLanguage` loads and is migrated; an invalid value falls back to
   `auto`.

## Manual test steps
1. Set `"voiceLanguage": "ta"` in `%APPDATA%/<app>/config.json`, restart `bun run dev`.
2. Hotkey, say in Tamil "notepad-ஐ திறந்து hello world என்று டைப் செய்" , hotkey. Confirm the overlay
   phases, an English user message with the Tamil shown beneath it, and the agent running.
3. Say "Thank you" in English or stay silent for 2s -> "Didn't catch that", no translation call
   in the console.
4. Unset `AGENT_API_KEY`, repeat step 2 -> fallback notice, Tamil delivered.
5. Set `"voiceLanguage": "auto"`, restart, speak English -> same as stage 4.
6. Say a Tamil delete request ("என் கோப்பை நீக்கு") -> English prompt, approval dialog still
   appears before anything is deleted.

## Known limits (not fixing here)
- Whisper's Tamil accuracy is the ceiling: a mis-heard word is translated faithfully wrong.
  Measure on real clips before promising more; a Tamil-tuned model is a separate stage.
- Other languages are not added. `voiceLanguage` is an enum so adding one later is a one-line
  change, but I am not building a language picker now.

## Implementation notes (added after building)
- Persisting the Tamil text needed a real column: `messages.original_text` (added via `ensureColumn`,
  so existing databases migrate on open). `Message.originalText` is set only on voice messages that
  were actually translated; an utterance that was already English carries none.
- `SessionManager.continueSession(id, content, { originalText })` gained the optional third
  argument; the typed-send path is unchanged.
- The pipeline initially emitted the `translating` UI state without setting its own phase, so a
  hotkey press during translation was not ignored. Caught by the "press while translating" test and
  fixed (`audio-pipeline.ts`).
- The fallback notice is "Couldn't translate — sent as heard" (the transcript is still delivered).
- `speech-server.test.ts` verifies the real server accepts the per-request `language` field using
  the English JFK clip with `language: "en"`. **A Tamil clip was not run through the real model** —
  Tamil recognition and translation quality are untested here (see Known limits).
