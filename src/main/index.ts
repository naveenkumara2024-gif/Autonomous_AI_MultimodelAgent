import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { registerHandler } from "./client-event-utils";
import { loadRenderer } from "./nav-server";
import { runPreflight } from "./preflight";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerHandler("app:getVersion", () => app.getVersion());

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  await loadRenderer(win);
}

app.whenReady().then(async () => {
  const preflight = await runPreflight();
  console.log(
    `[preflight] ${preflight.checks.length} check(s) configured, ok=${preflight.ok}`,
  );

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
