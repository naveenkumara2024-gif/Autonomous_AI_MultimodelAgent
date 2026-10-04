# Stage 4 — Voice + hotkey trigger (perception L1/L2)

## Goal
Implement AGENTS.md's L1 (global hotkey) and L2 (voice capture → text) perception layers:
press a global hotkey anywhere in Windows, speak, and the transcribed text is sent to the
active (or a new) session exactly like typing it — fully local, no cloud speech API.

## Layers touched
`src/main/perception/` (new: `global-hotkey.ts`, `speech-server.ts`, `audio-pipeline.ts`),
`src/renderer/OverlayWindow.tsx` (new — already named in AGENTS.md section 5's target tree),
`src/renderer/hooks/useVoiceCapture.ts` (new), `config-store.ts`, `preflight.ts`, `index.ts`,
preload + `vite-env.d.ts`, `electron-builder.json5`, `package.json`.

## Docs consulted
- AGENTS.md section 8: "End-of-utterance detection: default push-to-talk (hold hotkey), revisit
  VAD later." Section 9: L1 registers one hotkey and does nothing else while idle; L2/L3 fire
  concurrently on trigger; a trigger creates a new session or continues the active one, never a
  second concurrent session. Section 5: `perception/global-hotkey.ts`, `audio-recorder.ts`,
  `OverlayWindow.tsx` are named as the target files.
- Electron `globalShortcut` docs: registers a system-wide accelerator; fires once per press.
  **There is no key-release event** — this is the one place section 8's literal "hold hotkey"
  isn't directly implementable (decision 1 below).
- whisper.cpp releases (`ggml-org/whisper.cpp`, checked live): the CUDA Windows build
  (`whisper-cublas-11.8.0-bin-x64.zip`) ships `whisper-server.exe`, an HTTP server exposing
  `POST /inference` (multipart file upload → `{ text }`). Models are `.bin` files on Hugging
  Face (`ggerganov/whisper.cpp`).

## Code inspected
- `src/main/index.ts` — where `mcp.start()` is warmed at boot; the speech server is started the
  same way. `app.isPackaged` branch already exists for resolving a bundled exe
  (`mcp/server-command.ts`) — the speech server reuses that exact pattern.
- `src/main/mcp/mcp-client.ts` — the process-owning pattern (spawn, health, restart-with-backoff,
  never pass secrets into the child's env) that `speech-server.ts` is modeled on.
- `src/main/config/config-store.ts` — where the hotkey combo and voice settings are added,
  following the existing `AgentConfig`/`DEFAULT_CONFIG`/migration pattern.
- `src/main/preflight.ts` — where a new "hotkey free" check belongs (section 8 names this
  explicitly: "API keys set, hotkey free").
- `src/main/session/session-manager.ts` `continueSession()` — already throws if the session is
  mid-turn; the voice trigger surfaces that instead of queueing.
- **Live checks on this machine:** GPU is an RTX 3050 Laptop (4GB VRAM), driver 610.74 (CUDA
  12.x capable, and forward-compatible with CUDA 11.8 binaries). `nvidia-smi` confirms the
  hardware; no `ffmpeg` on PATH (confirms decision 5 below — avoid needing it).

## Decisions / assumptions (flagging for approval)

1. **Toggle-to-talk, not literal hold-to-talk — a forced deviation, not a style choice.**
   Electron's `globalShortcut` fires on key-down only; there is no OS-level key-up callback
   without a raw low-level keyboard hook (`WH_KEYBOARD_LL` via a native module with its own
   message-pump thread — a much bigger, more invasive addition, and the kind of thing that
   trips AV heuristics). So: **press the hotkey once to start recording, press it again (or
   click Stop in the overlay) to stop and transcribe.** A hard cap (60s) auto-stops so a missed
   second press can't record indefinitely. This is exactly the kind of revisit section 8
   anticipates ("revisit VAD later") — a real hold-to-talk hook is a valid future stage, not
   silently dropped.
2. **Default hotkey: `CommandOrControl+Shift+Space`.** No app currently running on this machine
   (checked: PowerToys/AutoHotkey/Flow Launcher/Everything are not running) holds it. Still
   user-configurable in `config.json` from day one — a hotkey collision is a real, common
   failure mode (section 12-style pitfall), and a fixed unconfigurable combo would be a trap.
3. **Model: `ggml-large-v3-turbo-q5_0` (~547MB) via the CUDA build, GPU-accelerated.** This
   machine's 4GB VRAM comfortably fits it (~1GB used) with headroom to spare, and it's
   multilingual (matches the supervisor prompt's "reply in the same language the user wrote
   in" — a transcription layer that only understood English would silently defeat that for
   non-English speakers). Verified apples-to-apples against `base.en` (150MB, English-only,
   fastest) and `small` (500MB, English-lean): turbo is the accuracy-per-second sweet spot on
   this GPU, per whisper.cpp's own published benchmarks. Configurable in `config.json`
   (`voiceModel`) for anyone who wants to trade accuracy for the smaller/faster `base.en`.
4. **whisper.cpp CUDA build: `whisper-cublas-11.8.0-bin-x64.zip` (270MB), not the 12.4.0 build
   (671MB).** CUDA's driver/runtime model is forward-compatible — an 11.8-compiled binary runs
   fine under this machine's driver (610.74, CUDA 12.x-capable) — so the smaller download loses
   nothing here. Flagging because this is an assumption about the *installer's* target
   machines in general, not just this one: a machine with a driver too old for CUDA 11.8 would
   fail. `speech-server.ts` detects a failed/crashed launch and falls back to *no voice*
   (typing still works) rather than blocking the app, with a clear preflight message.
5. **The server does the WAV encoding itself; no ffmpeg dependency.** `useVoiceCapture.ts`
   captures raw PCM directly via `AudioContext({ sampleRate: 16000 })` +
   `ScriptProcessorNode` (simplest reliable path for short clips; `AudioWorklet` is a possible
   later upgrade, not required here) and builds a 16kHz mono 16-bit WAV file by hand (a 44-byte
   header is all it takes) before sending it to main. This sidesteps `MediaRecorder`'s
   compressed webm/opus output entirely, so `whisper-server.exe` gets exactly the format it
   wants with no transcoding step — confirmed there's no `ffmpeg` on this machine, so relying on
   one would break on a fresh install.
6. **Recording capture lives in the renderer (`getUserMedia` is a web API), orchestration lives
   in main** — same main/preload/renderer split as everything else. Main owns: registering the
   hotkey, deciding which session receives the text, running/health-checking
   `whisper-server.exe`, and showing/hiding `OverlayWindow`. The renderer's `useVoiceCapture`
   hook owns: mic permission, PCM capture, WAV encoding, and streaming the bytes to main over
   IPC once recording stops.
7. **`OverlayWindow.tsx` is a second, small, frameless, always-on-top, transparent
   `BrowserWindow`** (not a layer inside the main window) — bottom-right corner, shows a
   pulsing mic icon, elapsed time, live partial word count is out of scope (that needs
   streaming transcription; this stage transcribes only after Stop), and a Stop button. It is
   created once at boot (hidden) and shown/hidden per trigger — not recreated each time — to
   avoid paying window-creation latency on every press.
8. **Hallucination/empty-clip filtering.** Whisper reliably hallucinates short stock phrases
   ("Thank you.", "Thanks for watching!", "Bye.") on near-silence. Clips under 400ms are
   discarded without calling the model at all; results that are empty or match a small known
   hallucination list are discarded with a neutral overlay message ("Didn't catch that") rather
   than being sent as a prompt.
9. **Target session, per section 9:** whatever session is currently selected in the renderer
   when the hotkey fires; if none is selected, a new one is created — identical semantics to
   the landing composer's `handleLandingSubmit`, reused rather than reimplemented. If the
   target session is already mid-turn, the overlay shows "Still working on the last request"
   and the transcript is discarded (not queued) — queuing silently is worse than a clear no-op
   here, and the user can just press the hotkey again once it's idle.
10. **Model/server files are NOT downloaded by `git`/npm install.** `whisper-server.exe` (from
    the CUDA zip) ships as an `extraResources` entry, same pattern as `mcp-desktop.exe`. The
    547MB model file is downloaded on first run (or via a `bun run setup:voice` script) into
    `<userData>/voice/`, not committed to the repo or the installer — a 547MB binary has no
    business in git history.

## Files to touch
Create:
- `src/main/perception/global-hotkey.ts` — registers/unregisters the configured accelerator;
  emits a toggle event; the preflight "hotkey free" check calls its own registration attempt.
- `src/main/perception/speech-server.ts` — spawns/health-checks/restarts `whisper-server.exe`
  (mirrors `mcp/mcp-client.ts`'s lifecycle shape); `transcribe(wavBytes): Promise<string|null>`.
- `src/main/perception/audio-pipeline.ts` — orchestrator: hotkey toggle → show/hide overlay →
  receive WAV from renderer → `speech-server.transcribe` → hallucination filter → route to
  `SessionManager.continueSession` for the target session.
- `src/main/perception/voice-server-command.ts` — resolves the packaged-vs-dev
  `whisper-server.exe` path, mirroring `mcp/server-command.ts`.
- `src/renderer/OverlayWindow.tsx`, `src/renderer/hooks/useVoiceCapture.ts`.
- `scripts/setup-voice-model.ts` (or a `postinstall`-adjacent dev script) — downloads the
  configured model into `<userData>/voice/` if missing.
- Tests: `speech-server.test.ts` (spawns the real server, feeds it `jfk.wav`, asserts the
  transcript contains "ask not"), `audio-pipeline.test.ts` (hallucination filter, min-duration
  cutoff, busy-session no-op — no real audio needed for these).

Modify:
- `config-store.ts`: `voiceHotkey: string`, `voiceModel: string`, `voiceEnabled: boolean`.
- `preflight.ts`: a "voice-hotkey" check (registers then immediately unregisters the configured
  accelerator to prove it's free) and a "voice-model" check (the model file exists on disk).
- `index.ts`: create the hidden `OverlayWindow` at boot, start `global-hotkey.ts` +
  `speech-server.ts` (background-warmed, same as the MCP client).
- `preload/index.ts` + `vite-env.d.ts`: overlay IPC (`voice.start`, `voice.stop`,
  `voice.audio-chunk` or a single final blob, `voice.state` event).
- `electron-builder.json5`: `extraResources` entry for `whisper-server.exe` (+ its CUDA DLLs).

## Safety implications
- Audio never leaves the device — local model, local server bound to `127.0.0.1` only.
- Raw audio is never persisted; only the final WAV buffer exists in memory during a single
  transcription and is discarded after. No `audioClip` is written to disk (AGENTS.md's DTC
  corpus opt-in path, if ever added, would be the only exception — not built here).
- The transcribed text goes through the exact same `continueSession` → agent → risk-classifier
  → approval-gate path as typed text. Voice adds no new trust — a spoken "delete my files"
  still stops at the approval dialog.
- Global hotkey registration is a real "always listening for this one combo" surface; it does
  nothing else while idle (section 9), and the mic is only opened between toggle-on and
  toggle-off, never continuously.

## Acceptance criteria
1. Press the hotkey anywhere (app not focused) → overlay appears within ~150ms.
2. Speak a short command, press the hotkey again → overlay hides, transcript appears in the
   active session's input exactly as if typed, and the turn runs normally (trace, approvals).
3. No session selected when triggered → a new session is created and receives the message,
   same as the landing composer — never two sessions from one press.
4. Silence or a sub-400ms clip → no message sent, overlay shows "Didn't catch that", no model
   call for the sub-400ms case.
5. Triggering while the active session is mid-turn → overlay shows "Still working…", nothing
   queued, no error.
6. `bun test`: speech-server round-trip on `jfk.wav`, hallucination filter, min-duration cutoff,
   busy-session no-op.
7. `bun run typecheck` clean; `bun run build` succeeds with the new `extraResources` entry.
8. Preflight reports the hotkey and model-file checks accurately (never a pass it didn't run).

## Manual test steps
1. Run `scripts/setup-voice-model.ts` (or let first boot fetch it), confirm the model lands in
   `<userData>/voice/`.
2. `bun run dev`. Check the console for `[preflight] ok voice-hotkey` / `ok voice-model`.
3. From another app (e.g. Notepad focused), press the hotkey, say "open notepad and type hello
   world", press it again. Confirm the overlay, the transcript, and that the agent actually runs.
4. Press the hotkey, stay silent for 2s, press it again — confirm "Didn't catch that", no turn.
5. Start a task that takes a while, trigger voice mid-turn — confirm the "still working" message
   and that nothing is queued or lost.
6. Change `voiceHotkey` in `config.json` to a combo already bound by another running app; restart;
   confirm preflight reports the conflict clearly instead of silently failing later.

## Implementation notes (added after building)
Findings that differ from the assumptions above — recorded so the next stage doesn't rediscover them:
- **Decision 4 did not hold: the CUDA 11.8 build cannot use the GPU on a stock machine.** Its
  `ggml-cuda.dll` imports `cublas64_11.dll`, which the `b5130` 11.8 zip does not ship (it expects
  a locally installed CUDA toolkit). ggml silently falls back to the CPU backend ("no GPU found"),
  so voice works but runs on CPU. The 12.4.0 zip (671MB) does include `cublas64_12.dll` /
  `cublasLt64_12.dll`. **Resolved: the project now pins the 12.4.0 build** (`voice-assets.ts`),
  verified on the RTX 3050 Laptop (`using CUDA0 backend`, model loaded on the GPU). `setup:voice`
  re-fetches when `cublas64_12.dll` is missing, so an old 11.8 install upgrades itself. The
  installer grows by roughly 400MB.
- whisper.cpp is pinned to release tag `b5130` (the newest tag with Windows binaries attached;
  `v1.9.4` has no assets). `scripts/setup-voice.ts` keeps only `whisper-server.exe` + DLLs (the zip
  also carries bench/stream/test tools that would bloat the installer).
- Extra files beyond the plan: `perception/overlay-window.ts` (the overlay `BrowserWindow`),
  `perception/voice-controller.ts` (Electron wiring), `perception/voice-assets.ts` (shared
  download/path helpers used by both the app and the setup script), `renderer/lib/wav.ts`.
- The overlay is the same renderer bundle loaded at `#overlay` (`main.tsx` picks the route).
  Only the overlay's webContents may drive `voice.*` IPC or hold a microphone permission.
- The hidden overlay would keep the app alive after the main window closes, so closing the main
  window now calls `app.quit()`.
