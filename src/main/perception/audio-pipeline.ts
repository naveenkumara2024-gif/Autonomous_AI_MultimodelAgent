/**
 * Voice trigger orchestrator (AGENTS.md section 9): hotkey toggle -> record -> transcribe ->
 * route to a session. Pure logic with every side effect injected, so the rules below are
 * unit-testable without Electron, a microphone or a model:
 *
 *   - toggle-to-talk: first trigger starts recording, the next one (or the overlay's Stop)
 *     stops it. A hard cap auto-stops so a missed second press can't record forever;
 *   - a trigger creates a new session or continues the selected one — never two sessions;
 *   - a busy target session is a clear no-op, never a silent queue;
 *   - clips shorter than MIN_CLIP_MS never reach the model, and Whisper's stock hallucinations
 *     on near-silence are dropped instead of being sent as a prompt.
 *
 * The transcript goes through SessionManager.continueSession exactly like typed text, so the
 * risk classifier and approval gate apply unchanged — voice adds no new trust.
 */

export type VoicePhase = "idle" | "recording" | "transcribing" | "notice";

export interface VoiceState {
  phase: VoicePhase;
  /** Human-readable text for the overlay (notice text, error, or transcript preview). */
  message?: string;
}

export type CaptureAction = "start" | "stop" | "abort";

export interface DeliveredPrompt {
  sessionId: string;
  created: boolean;
  text: string;
}

export interface AudioPipelineDeps {
  /** null = voice can be used right now; otherwise the reason it can't (shown in the overlay). */
  unavailableReason(): string | null;
  transcribe(wav: Uint8Array): Promise<string | null>;
  /** The session currently selected in the UI, or null on the landing page. */
  activeSessionId(): string | null;
  sessions: {
    isBusy(sessionId: string): boolean;
    create(): { id: string };
    send(sessionId: string, text: string): void;
  };
  ui: {
    setState(state: VoiceState): void;
    capture(action: CaptureAction): void;
  };
  onDelivered?(delivered: DeliveredPrompt): void;
  onLog?(line: string): void;
  maxRecordingMs?: number;
  noticeMs?: number;
}

export const MIN_CLIP_MS = 400;
export const MAX_RECORDING_MS = 60_000;
const NOTICE_MS = 2_500;
const SUBMIT_TIMEOUT_MS = 10_000;

// 16kHz mono 16-bit PCM behind a 44-byte header (what the renderer's encoder produces).
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 16_000 * 2;

export function wavDurationMs(wav: Uint8Array): number {
  return Math.max(0, Math.round(((wav.byteLength - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND) * 1000));
}

// Phrases Whisper emits for silence/noise (artifacts of its training data), plus its
// non-speech tags. Matched against the whole normalized transcript, never a substring.
const HALLUCINATIONS = new Set([
  "you",
  "bye",
  "bye bye",
  "goodbye",
  "thanks",
  "thank you",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thank you so much for watching",
  "please subscribe",
  "subtitles by the amaraorg community",
]);

export function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // [BLANK_AUDIO], (silence), [Music], *coughs* — a transcript made only of such tags.
  if (/^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*)+$/.test(trimmed)) return true;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length === 0 || HALLUCINATIONS.has(normalized);
}

export class AudioPipeline {
  private phase: VoicePhase = "idle";
  private targetSessionId: string | null = null;
  private recordingTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private submitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: AudioPipelineDeps) {}

  get currentPhase(): VoicePhase {
    return this.phase;
  }

  /** The hotkey (or the overlay's Stop button). */
  toggle(): void {
    if (this.phase === "recording") {
      this.stopRecording();
      return;
    }
    if (this.phase === "transcribing") return; // a clip is already being transcribed
    this.startRecording();
  }

  /** Discards an in-progress recording (Escape/cancel); nothing is transcribed or sent. */
  cancel(): void {
    if (this.phase !== "recording") return;
    this.clearRecordingTimer();
    this.deps.ui.capture("abort");
    this.setIdle();
  }

  /** The renderer could not capture audio (mic denied/unplugged). */
  captureFailed(reason: string): void {
    if (this.phase !== "recording" && this.phase !== "transcribing") return;
    this.clearRecordingTimer();
    this.deps.ui.capture("abort");
    this.showNotice(`Microphone unavailable: ${reason}`);
  }

  private startRecording(): void {
    this.clearNoticeTimer();
    const unavailable = this.deps.unavailableReason();
    if (unavailable) {
      this.showNotice(unavailable);
      return;
    }
    const target = this.deps.activeSessionId();
    if (target && this.deps.sessions.isBusy(target)) {
      this.showNotice("Still working on the last request");
      return;
    }
    this.targetSessionId = target;
    this.phase = "recording";
    this.deps.ui.setState({ phase: "recording" });
    this.deps.ui.capture("start");
    this.recordingTimer = setTimeout(() => {
      this.deps.onLog?.("recording hit the length cap; stopping");
      this.stopRecording();
    }, this.deps.maxRecordingMs ?? MAX_RECORDING_MS);
  }

  private stopRecording(): void {
    this.clearRecordingTimer();
    this.phase = "transcribing";
    this.deps.ui.setState({ phase: "transcribing" });
    this.deps.ui.capture("stop");
    // If the renderer never hands the clip back (capture crashed), don't sit in "transcribing".
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null;
      if (this.phase === "transcribing") this.showNotice("Didn't catch that");
    }, SUBMIT_TIMEOUT_MS);
  }

  /** The finished WAV from the renderer. Returns when routing (or the decision to drop it) is done. */
  async submit(wav: Uint8Array): Promise<void> {
    if (this.phase !== "transcribing") return; // stale/duplicate submission
    this.clearSubmitTimer();
    if (wavDurationMs(wav) < MIN_CLIP_MS) {
      this.showNotice("Didn't catch that");
      return;
    }

    let text: string | null;
    try {
      text = await this.deps.transcribe(wav);
    } catch (error) {
      this.deps.onLog?.(`transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      this.showNotice("Voice transcription failed");
      return;
    }
    if (text === null || isHallucination(text)) {
      this.showNotice("Didn't catch that");
      return;
    }
    this.deliver(text);
  }

  private deliver(text: string): void {
    try {
      let sessionId = this.targetSessionId;
      let created = false;
      if (sessionId && this.deps.sessions.isBusy(sessionId)) {
        this.showNotice("Still working on the last request");
        return;
      }
      if (!sessionId) {
        sessionId = this.deps.sessions.create().id;
        created = true;
      }
      this.deps.sessions.send(sessionId, text);
      this.deps.onDelivered?.({ sessionId, created, text });
      this.setIdle();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.onLog?.(`could not deliver transcript: ${reason}`);
      this.showNotice("Couldn't send that to the session");
    }
  }

  private showNotice(message: string): void {
    this.clearRecordingTimer();
    this.clearSubmitTimer();
    this.clearNoticeTimer();
    this.phase = "notice";
    this.deps.ui.setState({ phase: "notice", message });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      if (this.phase === "notice") this.setIdle();
    }, this.deps.noticeMs ?? NOTICE_MS);
  }

  private setIdle(): void {
    this.clearNoticeTimer();
    this.phase = "idle";
    this.targetSessionId = null;
    this.deps.ui.setState({ phase: "idle" });
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
  }

  private clearSubmitTimer(): void {
    if (this.submitTimer) clearTimeout(this.submitTimer);
    this.submitTimer = null;
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }
}
