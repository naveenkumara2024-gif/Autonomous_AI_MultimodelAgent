import { useEffect, useState } from "react";

export default function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.agentBridge
      .getAppVersion()
      .then(setVersion)
      .catch((err: unknown) => console.error("getAppVersion failed", err));
  }, []);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-base-950 text-ink">
      <div className="rounded-panel border border-border bg-base-900 px-8 py-6 shadow-panel">
        <h1 className="font-display text-xl">Autonomous AI Desktop Agent</h1>
        <p className="mt-2 text-sm text-ink-soft">Stage 0 scaffold — main/preload/renderer split</p>
        <p className="mt-4 font-mono text-xs text-ink-faint">
          app version: {version ?? "loading..."}
        </p>
      </div>
    </div>
  );
}
