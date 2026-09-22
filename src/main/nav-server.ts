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

  await win.loadFile(path.join(__dirname, "../renderer/index.html"));
}
