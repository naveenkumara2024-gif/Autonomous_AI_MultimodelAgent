import { useEffect, useRef, useState } from "react";
import { encodeWav, WAV_SAMPLE_RATE } from "../lib/wav";

export interface VoiceState {
  phase: "idle" | "recording" | "transcribing" | "notice";
  message?: string;
}

interface ActiveCapture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
}

function releaseCapture(capture: ActiveCapture): void {
  capture.processor.onaudioprocess = null;
  capture.processor.disconnect();
  capture.source.disconnect();
  for (const track of capture.stream.getTracks()) track.stop();
  void capture.context.close();
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Overlay-window side of the voice trigger: main says "start"/"stop"/"abort" (voice.capture),
 * this opens the microphone, records raw PCM at 16kHz and hands the finished WAV back to main.
 * The mic is only open between start and stop — never continuously. ScriptProcessorNode is the
 * simplest reliable path for short clips; AudioWorklet is a possible later upgrade.
 */
export function useVoiceCapture(): VoiceState {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const capture = useRef<ActiveCapture | null>(null);
  // Bumped on every start/abort so a getUserMedia that resolves late can tell it was superseded.
  const generation = useRef(0);
  const stopRequested = useRef(false);

  useEffect(() => {
    const bridge = window.agentBridge;
    if (!bridge) return;

    const finish = () => {
      const active = capture.current;
      capture.current = null;
      if (!active) return;
      const samples = concat(active.chunks);
      releaseCapture(active);
      void bridge.voiceSubmit(encodeWav(samples, WAV_SAMPLE_RATE));
    };

    const start = async () => {
      const mine = ++generation.current;
      stopRequested.current = false;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        const context = new AudioContext({ sampleRate: WAV_SAMPLE_RATE });
        await context.resume();
        if (mine !== generation.current) {
          for (const track of stream.getTracks()) track.stop();
          void context.close();
          return;
        }
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const chunks: Float32Array[] = [];
        processor.onaudioprocess = (event) => {
          chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        source.connect(processor);
        processor.connect(context.destination); // required for onaudioprocess to fire; output stays silent
        capture.current = { stream, context, source, processor, chunks };
        if (stopRequested.current) finish(); // Stop arrived while the mic was still opening
      } catch (error) {
        void bridge.voiceCaptureError(error instanceof Error ? error.message : String(error));
      }
    };

    const offCapture = bridge.onSessionEvent("voice.capture", (payload) => {
      const action = (payload as { action?: string }).action;
      if (action === "start") {
        void start();
      } else if (action === "stop") {
        stopRequested.current = true;
        finish();
      } else if (action === "abort") {
        generation.current++;
        stopRequested.current = false;
        if (capture.current) releaseCapture(capture.current);
        capture.current = null;
      }
    });
    const offState = bridge.onSessionEvent("voice.state", (payload) => setState(payload as VoiceState));

    return () => {
      offCapture();
      offState();
      if (capture.current) releaseCapture(capture.current);
      capture.current = null;
    };
  }, []);

  return state;
}
