import { useCallback, useState } from "react";

export type BackgroundEffect = "rays" | "shards";

const STORAGE_KEY = "background-effect";

function readStoredEffect(): BackgroundEffect {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "shards" ? "shards" : "rays";
  } catch {
    return "rays";
  }
}

export function useBackgroundEffect() {
  const [backgroundEffect, setBackgroundEffectState] = useState<BackgroundEffect>(readStoredEffect);

  const setBackgroundEffect = useCallback((next: BackgroundEffect) => {
    setBackgroundEffectState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // per-viewer convenience only — safe to no-op if storage is unavailable
    }
  }, []);

  const toggleBackgroundEffect = useCallback(() => {
    setBackgroundEffect(backgroundEffect === "rays" ? "shards" : "rays");
  }, [backgroundEffect, setBackgroundEffect]);

  return { backgroundEffect, setBackgroundEffect, toggleBackgroundEffect };
}
