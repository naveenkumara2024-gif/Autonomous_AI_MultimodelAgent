import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Dev server wiring for the Vite-built renderer. */
export async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  // Renderer builds to <root>/dist (vite.config.ts's `build.outDir`), not
  // dist-electron/renderer — this file lives at dist-electron/main/, so it's
  // two levels up, not one. See fix/production-blank-window.md.
  await win.loadFile(path.join(__dirname, "../../dist/index.html"));
}
