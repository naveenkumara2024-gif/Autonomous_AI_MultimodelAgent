import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme } from "electron";
import { registerHandler } from "./client-event-utils";
import { loadConfig } from "./config/config-store";
import { openDatabase } from "./db/database";
import { loadRenderer } from "./nav-server";
import { runPreflight } from "./preflight";
import { SessionManager } from "./session/session-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerHandler("app:getVersion", () => app.getVersion());

function registerSessionHandlers(win: BrowserWindow): void {
  const db = openDatabase();
  const config = loadConfig();
  const sessionManager = new SessionManager(db, config, (channel, payload) => {
    win.webContents.send(channel, payload);
  });

  registerHandler("session.list", () => sessionManager.listSessions());
  registerHandler("session.messages", (_e, sessionId: string) => sessionManager.listMessages(sessionId));
  registerHandler("session.create", (_e, title?: string) => sessionManager.createSession(title));
  registerHandler("session.start", (_e, sessionId: string) => sessionManager.startSession(sessionId));
  registerHandler("session.continue", (_e, sessionId: string, content: string) =>
    sessionManager.continueSession(sessionId, content),
  );
  registerHandler("session.rename", (_e, sessionId: string, title: string) =>
    sessionManager.renameSession(sessionId, title),
  );
  registerHandler("session.stop", (_e, sessionId: string) => sessionManager.stopSession(sessionId));
  registerHandler("session.delete", (_e, sessionId: string) => sessionManager.deleteSession(sessionId));
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // BrowserWindow's own paint defaults to white; at non-100% display
    // scaling Chromium's compositor can briefly show it through as a seam
    // wherever the page hasn't painted over it yet (e.g. under the menu
    // bar) — visible as a stray white line whenever the app is in dark
    // mode. Matching it to the renderer's actual starting theme (same
    // light/dark default useTheme.ts falls back to: OS preference, since
    // nothing is stored yet on first paint) makes that seam invisible
    // instead of chasing every gap. Light-mode values match Electron's
    // white default anyway, so this only changes anything for dark mode.
    // See fix/window-white-seam.md.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  registerSessionHandlers(win);

  await loadRenderer(win);
}

app.whenReady().then(async () => {
  const preflight = await runPreflight();
  console.log(
    `[preflight] ${preflight.checks.length} check(s) configured, ok=${preflight.ok}`,
  );

  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
