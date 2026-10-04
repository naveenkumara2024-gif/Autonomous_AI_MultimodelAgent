import { describe, expect, test } from "bun:test";
import { AudioPipeline, type AudioPipelineDeps, type CaptureAction, type DeliveredPrompt, type VoiceState, isHallucination, wavDurationMs } from "./audio-pipeline";

// Stage-4 acceptance criteria 3-5: no-session trigger creates exactly one session, silence and
// sub-400ms clips never reach the model, a busy session is a clear no-op. No audio or model needed.

/** A WAV of `ms` milliseconds of silence: 44-byte header + 16kHz mono 16-bit samples. */
function fakeWav(ms: number): Uint8Array {
  return new Uint8Array(44 + Math.round((ms / 1000) * 16_000) * 2);
}

interface Harness {
  pipeline: AudioPipeline;
  states: VoiceState[];
  captures: CaptureAction[];
  transcribeCalls: number;
  created: string[];
  sent: Array<{ sessionId: string; text: string }>;
  delivered: DeliveredPrompt[];
}

function build(options: {
  transcript?: string | null;
  activeSessionId?: string | null;
  busy?: string[];
  unavailable?: string | null;
  transcribeError?: boolean;
  maxRecordingMs?: number;
  sendError?: boolean;
}): Harness {
  const h: Harness = { pipeline: null as never, states: [], captures: [], transcribeCalls: 0, created: [], sent: [], delivered: [] };
  const deps: AudioPipelineDeps = {
    unavailableReason: () => options.unavailable ?? null,
    transcribe: async () => {
      h.transcribeCalls++;
      if (options.transcribeError) throw new Error("server down");
      return options.transcript === undefined ? "open notepad" : options.transcript;
    },
    activeSessionId: () => options.activeSessionId ?? null,
    sessions: {
      isBusy: (id) => (options.busy ?? []).includes(id),
      create: () => {
        const id = `new-${h.created.length + 1}`;
        h.created.push(id);
        return { id };
      },
      send: (sessionId, text) => {
        if (options.sendError) throw new Error("session deleted");
        h.sent.push({ sessionId, text });
      },
    },
    ui: { setState: (s) => h.states.push(s), capture: (a) => h.captures.push(a) },
    onDelivered: (d) => h.delivered.push(d),
    maxRecordingMs: options.maxRecordingMs,
    noticeMs: 5,
  };
  h.pipeline = new AudioPipeline(deps);
  return h;
}

const lastState = (h: Harness) => h.states[h.states.length - 1];

describe("audio pipeline", () => {
  test("toggle starts then stops recording", () => {
    const h = build({});
    h.pipeline.toggle();
    expect(h.pipeline.currentPhase).toBe("recording");
    expect(h.captures).toEqual(["start"]);
    h.pipeline.toggle();
    expect(h.pipeline.currentPhase).toBe("transcribing");
    expect(h.captures).toEqual(["start", "stop"]);
  });

  test("no session selected -> creates exactly one new session and sends the transcript to it", async () => {
    const h = build({ activeSessionId: null });
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(2000));
    expect(h.created).toEqual(["new-1"]);
    expect(h.sent).toEqual([{ sessionId: "new-1", text: "open notepad" }]);
    expect(h.delivered).toEqual([{ sessionId: "new-1", created: true, text: "open notepad" }]);
    expect(h.pipeline.currentPhase).toBe("idle");
  });

  test("session selected -> continues it without creating another", async () => {
    const h = build({ activeSessionId: "s1" });
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(2000));
    expect(h.created).toEqual([]);
    expect(h.sent).toEqual([{ sessionId: "s1", text: "open notepad" }]);
    expect(h.delivered[0]?.created).toBe(false);
  });

  test("a clip under 400ms never calls the model and sends nothing", async () => {
    const h = build({});
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(300));
    expect(h.transcribeCalls).toBe(0);
    expect(h.sent).toEqual([]);
    expect(lastState(h)).toEqual({ phase: "notice", message: "Didn't catch that" });
  });

  test("a clip of exactly 400ms is transcribed", async () => {
    const h = build({});
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(400));
    expect(h.transcribeCalls).toBe(1);
  });

  test("empty and hallucinated transcripts are dropped, not sent", async () => {
    for (const transcript of [null, "", "Thank you.", "Thanks for watching!", "[BLANK_AUDIO]", "(silence)"]) {
      const h = build({ transcript });
      h.pipeline.toggle();
      h.pipeline.toggle();
      await h.pipeline.submit(fakeWav(2000));
      expect(h.sent).toEqual([]);
      expect(h.created).toEqual([]);
      expect(lastState(h)?.message).toBe("Didn't catch that");
    }
  });

  test("busy target session: clear notice, no recording, nothing queued", () => {
    const h = build({ activeSessionId: "s1", busy: ["s1"] });
    h.pipeline.toggle();
    expect(h.captures).toEqual([]);
    expect(h.pipeline.currentPhase).toBe("notice");
    expect(lastState(h)).toEqual({ phase: "notice", message: "Still working on the last request" });
    expect(h.sent).toEqual([]);
  });

  test("session that becomes busy while recording: transcript is discarded, not queued", async () => {
    const busy: string[] = [];
    const h = build({ activeSessionId: "s1", busy });
    h.pipeline.toggle();
    busy.push("s1");
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(2000));
    expect(h.sent).toEqual([]);
    expect(lastState(h)?.message).toBe("Still working on the last request");
  });

  test("voice unavailable: shows the reason and never starts the mic", () => {
    const h = build({ unavailable: "Voice model is downloading (40%)" });
    h.pipeline.toggle();
    expect(h.captures).toEqual([]);
    expect(lastState(h)?.message).toBe("Voice model is downloading (40%)");
  });

  test("transcription failure shows a notice and sends nothing", async () => {
    const h = build({ transcribeError: true });
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(2000));
    expect(h.sent).toEqual([]);
    expect(lastState(h)?.message).toBe("Voice transcription failed");
  });

  test("a delivery failure (e.g. session deleted) is reported, not thrown", async () => {
    const h = build({ activeSessionId: "s1", sendError: true });
    h.pipeline.toggle();
    h.pipeline.toggle();
    await h.pipeline.submit(fakeWav(2000));
    expect(lastState(h)?.message).toBe("Couldn't send that to the session");
  });

  test("the recording cap auto-stops", async () => {
    const h = build({ maxRecordingMs: 20 });
    h.pipeline.toggle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.captures).toEqual(["start", "stop"]);
    expect(h.pipeline.currentPhase).toBe("transcribing");
  });

  test("cancel aborts the recording and returns to idle", () => {
    const h = build({});
    h.pipeline.toggle();
    h.pipeline.cancel();
    expect(h.captures).toEqual(["start", "abort"]);
    expect(h.pipeline.currentPhase).toBe("idle");
  });

  test("a stale submission outside the transcribing phase is ignored", async () => {
    const h = build({});
    await h.pipeline.submit(fakeWav(2000));
    expect(h.transcribeCalls).toBe(0);
  });
});

describe("helpers", () => {
  test("wavDurationMs reads length from the byte count", () => {
    expect(wavDurationMs(fakeWav(1000))).toBe(1000);
    expect(wavDurationMs(new Uint8Array(10))).toBe(0);
  });

  test("isHallucination matches whole transcripts only", () => {
    expect(isHallucination("Thank you.")).toBe(true);
    expect(isHallucination("  Bye!  ")).toBe(true);
    expect(isHallucination("thank you for opening the file")).toBe(false);
    expect(isHallucination("open notepad and type thank you")).toBe(false);
  });
});
