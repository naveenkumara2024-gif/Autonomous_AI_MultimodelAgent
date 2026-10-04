import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { TraceStore } from "./agent/trace";
import { registerHandler } from "./client-event-utils";
import { loadConfig } from "./config/config-store";
import { loadEnvFile } from "./config/load-env";
import { openDatabase } from "./db/database";
import { McpClientManager } from "./mcp/mcp-client";
import { resolveMcpServerCommand } from "./mcp/server-command";
import { loadRenderer } from "./nav-server";
import { probeHotkey } from "./perception/global-hotkey";
import { startVoice, voiceDir, type VoiceController } from "./perception/voice-controller";
import { modelPath, isValidModelName } from "./perception/voice-assets";
import { runPreflight, voiceModelCheck } from "./preflight";
import { ApprovalGate } from "./sandbox/approval-gate";
import { resourceLocks } from "./sandbox/resource-lock-manager";
import { SessionManager } from "./session/session-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, "../..");

// dist-electron/main/ -> project root is two levels up (same relative
// pattern nav-server.ts uses for dist/index.html). Must run before
// anything reads process.env.TITLE_GEN_* / AGENT_* — see config/load-env.ts.
loadEnvFile(path.join(APP_ROOT, ".env"));

const mcpServer = resolveMcpServerCommand({ isPackaged: app.isPackaged, appRoot: APP_ROOT, resourcesPath: process.resourcesPath });

// Dev-only, opt-in: exposes the renderer over the Chrome DevTools Protocol so the UI can be
// driven end-to-end by a script. Never available in a packaged build.
if (!app.isPackaged && process.env.AGENT_DEBUG_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.AGENT_DEBUG_CDP_PORT);
}

let mcp: McpClientManager | null = null;
let approvals: ApprovalGate | null = null;
let voice: VoiceController | null = null;

registerHandler("app:getVersion", () => app.getVersion());

function registerSessionHandlers(win: BrowserWindow): { sessionManager: SessionManager; config: ReturnType<typeof loadConfig>; send: (channel: string, payload: unknown) => void } {
  const db = openDatabase();
  const config = loadConfig();
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // One automation server, one approval table and one lock table for the whole app — they
  // guard the single real desktop that every session shares.
  mcp = new McpClientManager({
    server: mcpServer,
    dataDir: path.join(app.getPath("userData"), "mcp-desktop"),
    onLog: (entry) => {
      if (entry.level !== "debug") console.log(`[mcp:${entry.source}] ${entry.level} ${entry.message}${entry.data ? ` ${JSON.stringify(entry.data).slice(0, 300)}` : ""}`);
    },
  });
  approvals = new ApprovalGate(send);
  const traces = new TraceStore(db, path.join(app.getPath("userData"), "traces"), send);

  const sessionManager = new SessionManager(db, config, send, {
    mcp,
    approvals,
    locks: resourceLocks,
    traces,
    policy: () => ({ allowScreenshotsToModel: config.allowScreenshotsToModel }),
  });

  // Warm the automation server in the background so the first prompt doesn't pay its startup.
  mcp.start().catch((error) => console.error(`[mcp] initial start failed: ${error instanceof Error ? error.message : error}`));

  registerHandler("session.list", () => sessionManager.listSessions());
  registerHandler("session.messages", (_e, sessionId: string) => sessionManager.listMessages(sessionId));
  registerHandler("session.trace", (_e, sessionId: string) => sessionManager.listTrace(sessionId));
  registerHandler("session.create", (_e, title?: string) => sessionManager.createSession(title));
  registerHandler("session.start", (_e, sessionId: string) => sessionManager.startSession(sessionId));
  registerHandler("session.continue", (_e, sessionId: string, content: string) =>
    sessionManager.continueSession(sessionId, content),
  );
  registerHandler("session.cancel", (_e, sessionId: string) => sessionManager.cancelTurn(sessionId));
  registerHandler("session.rename", (_e, sessionId: string, title: string) =>
    sessionManager.renameSession(sessionId, title),
  );
  registerHandler("session.stop", (_e, sessionId: string) => sessionManager.stopSession(sessionId));
  registerHandler("session.delete", (_e, sessionId: string) => sessionManager.deleteSession(sessionId));

  registerHandler("trace.image", (_e, imagePath: string) => traces.readImage(imagePath));
  registerHandler("approval.list", () => approvals!.list());
  registerHandler("approval.respond", (_e, id: string, approved: boolean) => approvals!.respond(id, approved === true));

  return { sessionManager, config, send };
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

  // Agent replies contain source links. A link must open in the user's browser — never
  // navigate the app window itself away from the UI, and never open an Electron child window.
  const openExternally = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      openExternally(url);
    }
  });

  // The hidden voice overlay is also a BrowserWindow, so "window-all-closed" would never fire
  // once the main window is gone — closing the main window has to quit explicitly.
  win.on("closed", () => app.quit());

  const { sessionManager, config, send } = registerSessionHandlers(win);

  await loadRenderer(win);

  // Perception L1/L2: global hotkey -> overlay -> local speech-to-text -> the same
  // continueSession path typed prompts use. Started after the main window so the overlay
  // (a second window) never competes with it for first paint.
  voice = startVoice({ config, sessionManager, sendToMain: send, appRoot: APP_ROOT });
}

app.whenReady().then(async () => {
  const config = loadConfig();
  const extraChecks = config.voiceEnabled
    ? [
        { name: "voice-hotkey", ...probeHotkey(config.voiceHotkey) },
        isValidModelName(config.voiceModel)
          ? voiceModelCheck(modelPath(voiceDir(), config.voiceModel))
          : { name: "voice-model", passed: false, detail: `invalid voiceModel "${config.voiceModel}"` },
      ]
    : [];
  const preflight = await runPreflight({ mcpServer, extraChecks });
  for (const check of preflight.checks) {
    console.log(`[preflight] ${check.passed ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
  }

  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  // Nothing flagged may run after the user can no longer see or answer its dialog.
  approvals?.denyAll();
  voice?.stop();
  void mcp?.stop();
});
