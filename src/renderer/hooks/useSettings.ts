import { useEffect, useState } from "react";
import type { SettingsSnapshot } from "../types";

/** The provider list + toggles from main, kept live from "settings.changed". Null until loaded. */
export function useSettings(): SettingsSnapshot | null {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);

  useEffect(() => {
    if (!window.agentBridge) return;
    let cancelled = false;
    window.agentBridge
      .getSettings()
      .then((s) => !cancelled && s && setSnapshot(s))
      .catch(console.error);
    const off = window.agentBridge.onSessionEvent("settings.changed", (payload) => setSnapshot(payload as SettingsSnapshot));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return snapshot;
}
