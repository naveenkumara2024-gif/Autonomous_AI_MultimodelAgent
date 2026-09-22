/// <reference types="vite/client" />

// Mirrors the shape exposed by src/preload/index.ts. Not imported directly
// from there — preload belongs to tsconfig.node.json's project, and this
// file belongs to tsconfig.app.json's, so the shape is duplicated here.
// No import/export in this file, so it's already an ambient script — no
// `declare global` wrapper needed (and it silently no-ops if added since
// there's nothing to make this a module in the first place).
interface Window {
  agentBridge: {
    getAppVersion: () => Promise<string>;
  };
}
