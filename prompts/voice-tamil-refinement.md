# Voice: refine Tamil → English accuracy

## Goal
Make the English prompt produced from spoken Tamil more accurate. The first Tamil → English
feature (`prompts/voice-tamil-to-english.md`) works end to end, but the one real sample we have
(romanized Tamil, transcribed while `voiceLanguage` was still `auto`) lost most of the meaning
*before* the translator ever saw it. This stage improves each link of the chain — speech model,
Whisper hints, translator context — and adds an optional review-before-send mode so a residual
mistranslation can be fixed by the user instead of acted on by the agent.

## Layers touched
Perception L2 (`src/main/perception/`), config, one small renderer change (draft prefill), and a
dev-only evaluation script. Supervisor, subagents, sandbox, risk classifier and approval gate are
**not** touched.

## Docs consulted
- AGENTS.md section 3/9/14 (no audio persists; nothing sent unredacted; safety over autonomy),
  section 8 (open decisions are confirmed before implementing).
- `prompts/voice-tamil-to-english.md` — decisions 1, 5, 6, 7 and its "Known limits".
- whisper.cpp `whisper-server --help` for the pinned build (`b5130`, run locally): the server
  exposes `--prompt` (initial prompt), `--carry-initial-prompt`, `-bs` (beam size, default -1 =
  greedy), `-bo` (best-of), `-sns` (suppress non-speech tokens) and `--vad`.
- Hugging Face `ggerganov/whisper.cpp`: `ggml-large-v3-q5_0.bin` (~1.1 GB) alongside the current
  `ggml-large-v3-turbo-q5_0.bin` (~550 MB).

## Code inspected
- `perception/speech-server.ts` — launch args are `-l auto -nt`; `transcribe()` already sends a
  per-request `language`. No prompt and no beam search are configured.
- `perception/voice-translator.ts` — single-utterance translation, one system prompt, no session
  context, no examples. `translateToEnglish(text, { model })`.
- `perception/audio-pipeline.ts` / `voice-controller.ts` — `deliver()` always sends straight to
  `continueSession`; `activeSessionId` and `targetSessionId` already identify the session.
- `perception/voice-assets.ts` — model download is generic over `voiceModel`, so switching the model
  is a config value, not new download code.
- `renderer/App.tsx` — composer state is `draft` (open session) and `landingDraft` (no session);
  `voice.focus-session` already selects a session from main.
- `session/session-store.ts` — `listMessages()` supplies recent turns for translator context.
- Live measurements already made this session: the agent endpoint takes 7–110 s per translation
  (reasoning model); paid models return "Insufficient credits" on the current key.

## Decisions / assumptions (flagging for approval)

1. **Measure before choosing — an evaluation script comes first.** Accuracy changes cannot be
   unit-tested without Tamil audio, and I do not speak Tamil well enough to judge output by eye.
   `scripts/eval-tamil-voice.ts` takes a folder of your own recorded clips (`name.wav` + `name.txt`
   containing the English you meant) and runs each configuration, printing transcript, English
   output, latency and a simple word-overlap score. The code changes below are then kept or dropped
   on those numbers. **This needs ~10–15 short Tamil recordings from you** (e.g. record them with
   the hotkey flow or Windows Voice Recorder). They stay local in a gitignored `corpus/tamil/`
   folder, are never sent anywhere except through the same local whisper + the same translator
   endpoint the app already uses, and are not committed.
2. **Stronger speech model: try `large-v3-q5_0` against the current `large-v3-turbo-q5_0`.**
   Turbo prunes the decoder, which costs the most on low-resource languages such as Tamil. Expected
   cost: ~550 MB more disk, slower transcription, more VRAM (should still fit the 4 GB RTX 3050 —
   I will verify with `nvidia-smi`, not assume). Applied only if the eval shows a real gain; it is a
   one-value change (`voiceModel`) because download/resolve logic is already generic. English
   (`auto`) users keep the turbo default.
3. **Beam search for the Tamil path.** Greedy decoding (the current default) is the weakest
   setting for hard audio. Launch with `-bs 5` when `voiceLanguage` is `ta`. The server is started
   once at boot, so this is a launch arg, set from config — `auto` mode launches exactly as today.
   Kept only if the eval shows it helps without an unacceptable latency hit.
4. **Whisper vocabulary hint.** Pass an initial prompt biasing toward the commands you actually say
   ("Open the browser, search, click Student Login, type, open Notepad, Chrome, file, folder…" in a
   Tamil/English code-mixed style). Mechanism to confirm: the pinned `b5130` server clearly has
   `--prompt` as a **launch** arg; I have not confirmed it accepts a **per-request** `prompt` form
   field. Plan: test per-request first; if unsupported, fall back to the launch arg (which is fine —
   the prompt is static). A hint can also *hurt* (Whisper may echo it on silence), so the existing
   hallucination filter gets the hint text added as a known-echo, and the eval decides if it stays.
5. **Richer translator context.** The translator prompt additionally receives (a) a one-line
   statement that this is a voice command for a desktop-automation agent (open/search/click/type/
   file/browser), (b) 5–6 few-shot pairs of romanized Tamil / Tamil script / code-mixed → imperative
   English, and (c) the last two user messages of the session as *context only* (to resolve words
   like "that" or "again"). The speech stays inside `<speech>` tags and the context in a separate
   `<context>` block, both explicitly labelled as data — the injection protection from the first
   stage must be preserved, and the context block is a new thing an attacker-controlled earlier
   message could try to abuse, so a test covers it.
6. **Optional review-before-send mode: new config `voiceReview: boolean`, default `false`.** When
   on, a translated utterance is *not* sent. Main pushes the English to the renderer, which fills the
   composer (`draft`, or `landingDraft` if no session) and focuses it; the user edits and presses
   Enter, exactly like typed text. The Tamil original is shown beside it. This is the only change
   that makes a bad translation harmless, at the cost of one extra keypress per utterance. It
   applies to the translation path only; English (`auto`) behaviour is unchanged. No new trust: what
   the user sends is typed-equivalent text through the same `continueSession` gate.
7. **Not doing:** n-best/ensembling of several Whisper hypotheses (too much complexity for unproven
   gain); fine-tuning a Tamil model (a separate project); switching the translation model (blocked on
   your account's credits, not on code — `voiceTranslationModel` already makes it a config swap);
   enabling `--vad` (needs another model download and the eval has no evidence it is the problem).

## Files to touch
Create:
- `scripts/eval-tamil-voice.ts` — runs the clip folder through chosen (model, beam, prompt, context)
  combinations; needs the setup script's whisper binary and an `AGENT_*` key; prints a table.
  Dev-only, not shipped, not wired into `build`.
- `src/main/perception/translator-context.ts` — builds the context + few-shot messages (pure, so it
  is unit-tested) from `{ speech, recentUserMessages }`.
- Tests: `translator-context.test.ts` (examples included, only the last two user messages, context
  tagged as data, an injection string inside context is wrapped and not placed in the system prompt),
  and extensions to `audio-pipeline.test.ts` for review mode.

Modify:
- `config-store.ts` — `voiceReview: boolean` (default false), `voiceBeamSize` (default 5 for `ta`
  only; ignored for `auto`), `voicePrompt` (default: the vocabulary hint; empty string disables).
- `speech-server.ts` — accept extra launch args (beam size, prompt) from options; `auto` launch args
  stay identical to today.
- `voice-controller.ts` — pass the new options; supply `recentUserMessages` to the translator;
  implement the review hand-off.
- `voice-translator.ts` — accept `{ context?: string[] }`, use the few-shot messages.
- `audio-pipeline.ts` — `deliver()` gains a review branch: instead of `sessions.send`, call a new
  injected `ui.draft({ sessionId, created: false, english, original })`. Hallucination filter
  extended with the hint text.
- `preload/index.ts`, `renderer/vite-env.d.ts`, `renderer/App.tsx` — a `voice.draft` event that
  prefills and focuses the composer.
- `.gitignore` — `corpus/tamil/`.
- `prompts/voice-tamil-to-english.md` — a one-line pointer to this stage, no rewrite.

## Safety implications
- Audio still never leaves the device; whisper stays on `127.0.0.1`. The eval script uses clips you
  provide, keeps them in a gitignored local folder, and sends only the **transcript text** to the
  existing translator endpoint — same destination and data class as the feature already uses.
- The context block carries earlier *user* messages into a model call that previously saw only the
  current utterance. They are text the user already sent to the same endpoint, but it is a new
  data path, so it is labelled as data, kept out of the system prompt, and covered by an injection
  test. Assistant/tool output and screen content are **not** included.
- Review mode never bypasses anything: it only changes *who presses send*. The risk classifier still
  matches literal tool-call `args`; the approval gate is untouched.
- A longer initial prompt makes Whisper more likely to echo it on silence; the hallucination filter
  extension and the eval's silence clip cover this.

## Acceptance criteria
1. The eval script runs on a clip folder and prints, per clip and configuration: Whisper transcript,
   English output, latency, overlap score. Run on your real clips with real output reported — I will
   not claim an improvement without those numbers.
2. Only changes that improve the eval (or are neutral on accuracy and clearly safer) are kept as
   defaults; anything that does not help is left disabled or removed and noted here.
3. `voiceLanguage: "auto"` behaviour and launch args are byte-identical to today; existing 181
   tests still pass.
4. `voiceReview: true`: a Tamil utterance results in the English text sitting in the composer for the
   right session (existing, or the landing composer if none), nothing sent until Enter; Tamil shown
   alongside; with `false` the current send-immediately flow is unchanged.
5. Silence with the vocabulary hint enabled does not produce the hint as a prompt.
6. An injection phrase in an earlier user message is treated as context data and does not change the
   translation task (test).
7. `bun run typecheck`, `bun test`, `bun run build` pass with real output reported. (No lint script
   exists in this repo.)

## Manual test steps
1. Record 10–15 short Tamil clips (mix of pure Tamil script speech, romanized/code-mixed speech like
   your "browser open panni … student login klik panna", and one silent clip), with the English you
   meant in matching `.txt` files in `corpus/tamil/`.
2. `bun run setup:voice`, then run the eval script; first baseline (turbo, greedy, no hint, no
   context), then each change one at a time. Read the table with me.
3. Restart the app with the winning settings and speak the same sentences through the hotkey.
4. Turn `voiceReview` on, speak, confirm the English lands in the composer unsent, edit it, send.
5. Turn it off, confirm the old send-immediately flow, and confirm `auto` English still works.

## Open questions for you
1. **Recordings:** are you willing to provide the ~10–15 Tamil clips? Without them I can still
   build every code change, but I cannot show that any of them improved accuracy, so I would ship
   them disabled by default.
2. **`large-v3-q5_0`:** OK to download ~1.1 GB for the comparison? (Only used if it wins.)
3. **Review mode:** default off as proposed, or on while you are tuning accuracy?
