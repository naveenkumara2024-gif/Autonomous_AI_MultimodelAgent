import { Loader2, Mic, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useVoiceCapture } from "./hooks/useVoiceCapture";

function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/**
 * The recording indicator shown in the always-on-top overlay window (route "#overlay").
 * Pure display + a Stop button: all state transitions are decided in main
 * (perception/audio-pipeline.ts) and arrive as voice.state events.
 */
export function OverlayWindow() {
  const state = useVoiceCapture();
  const recording = state.phase === "recording";
  const seconds = useElapsedSeconds(recording);

  // The overlay window is transparent; the app shell's opaque body background must not paint it.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  if (state.phase === "idle") return null;

  return (
    <div className="flex h-screen w-screen items-center p-2 select-none">
      <div className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900/95 px-4 py-3 text-white shadow-lg">
        {recording && (
          <>
            <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-red-500/20 text-red-400">
              <span className="absolute inset-0 animate-ping rounded-full bg-red-500/30" />
              <Mic className="relative h-4 w-4" />
            </span>
            <div className="flex-1">
              <div className="text-sm font-medium">Listening…</div>
              <div className="font-mono text-xs text-white/60">
                {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void window.agentBridge.voiceToggle()}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium hover:bg-white/20"
            >
              <Square className="h-3 w-3 fill-current" /> Stop
            </button>
          </>
        )}
        {state.phase === "transcribing" && (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-white/70" />
            <div className="text-sm font-medium">Transcribing…</div>
          </>
        )}
        {state.phase === "notice" && <div className="text-sm font-medium">{state.message}</div>}
      </div>
    </div>
  );
}
