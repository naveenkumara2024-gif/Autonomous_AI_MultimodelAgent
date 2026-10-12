import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type IpcMainInvokeEvent, nativeTheme, safeStorage, shell } from "electron";
import { TraceStore } from "./agent/trace";
import { registerHandler } from "./client-event-utils";
import { loadConfig, saveConfig } from "./config/config-store";
import { loadEnvFile } from "./config/load-env";
import { openDatabase } from "./db/database";
import { McpClientManager } from "./mcp/mcp-client";
import { ActionCache } from "./memory/action-cache";
import { resolveMcpServerCommand } from "./mcp/server-command";
import { AutomationController } from "./overlay/automation-controller";
import { AutomationOverlay } from "./overlay/automation-overlay";
import { loadRenderer } from "./nav-server";
import { probeHotkey } from "./perception/global-hotkey";
import { startVoice, voiceDir, type VoiceController } from "./perception/voice-controller";
import { modelPath, isValidModelName } from "./perception/voice-assets";
import { runPreflight, voiceModelCheck } from "./preflight";
import { ApprovalGate } from "./sandbox/approval-gate";
import { resourceLocks } from "./sandbox/resource-lock-manager";
import { SessionManager } from "./session/session-manager";
import { installEndpointResolver } from "./settings/llm-endpoint";
import { ProviderStore } from "./settings/provider-store";
import { safeStorageCipher } from "./settings/safe-cipher";
import { registerSettingsHandlers } from "./settings/settings-handlers";
import { SettingsService } from "./settings/settings-service";

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
let automationOverlay: AutomationOverlay | null = null;
let providers: ProviderStore | null = null;

// What the automation overlay needs to hear: the same stream the main window gets, minus voice.
const OVERLAY_CHANNELS = new Set(["trace.event", "approval.request", "approval.resolved", "session.status", "session.update", "session.message"]);

registerHandler("app:getVersion", () => app.getVersion());

function registerSessionHandlers(win: BrowserWindow): { sessionManager: SessionManager; config: ReturnType<typeof loadConfig>; send: (channel: string, payload: unknown) => void } {
  const db = openDatabase();
  const config = loadConfig();

  // The always-on-top automation overlay (live steps + approvals). It watches the same event
  // stream as the main window; nothing in the agent code knows it exists.
  const overlay = new AutomationOverlay(path.join(app.getPath("userData"), "automation-overlay.json"));
  automationOverlay = overlay;
  const automation = new AutomationController({
    overlay,
    mainWindow: { isOnScreen: () => !win.isDestroyed() && win.isVisible() && !win.isMinimized(), minimize: () => win.minimize() },
    enabled: () => config.automationOverlayEnabled,
    minimizeMainWindow: () => config.automationMinimizeMainWindow,
  });
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
    if (OVERLAY_CHANNELS.has(channel)) overlay.send(channel, payload);
    automation.observe(channel, payload);
  };
  // Only our own two UI windows may see or answer approvals (the voice overlay shares the
  // preload bridge and must not be able to approve anything).
  const isOverlay = (e: IpcMainInvokeEvent) => overlay.webContentsId !== null && e.sender.id === overlay.webContentsId;
  const isTrusted = (e: IpcMainInvokeEvent) => e.sender.id === win.webContents.id || isOverlay(e);

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
  const actionCache = new ActionCache(db);

  const sessionManager = new SessionManager(db, config, send, {
    mcp,
    approvals,
    locks: resourceLocks,
    traces,
    policy: () => ({ allowScreenshotsToModel: config.allowScreenshotsToModel }),
    actionCache,
    actionCacheEnabled: () => config.actionCacheEnabled,
    dodgeOverlay: (point) => overlay.dodge(point),
    inputBlockedReason: () =>
      BrowserWindow.getFocusedWindow() && approvals!.list().length > 0
        ? "Refused: an approval is waiting and the Autonomous AI window has keyboard focus, so a keystroke could answer it. Nothing was typed. It will work once the user answers the approval."
        : null,
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

  registerHandler("actionCache.clear", () => actionCache.clear());
  registerHandler("trace.image", (_e, imagePath: string) => traces.readImage(imagePath));
  registerHandler("approval.list", (e) => (isTrusted(e) ? approvals!.list() : []));
  registerHandler("approval.respond", (e, id: string, approved: boolean) => {
    if (isTrusted(e)) approvals!.respond(id, approved === true);
  });

  // Settings page (providers, automation toggles). Main window only.
  const settings = new SettingsService({
    store: providers!,
    config,
    saveConfig,
    secureStorageAvailable: () => safeStorage.isEncryptionAvailable(),
    onChange: (snapshot) => {
      if (!win.isDestroyed()) win.webContents.send("settings.changed", snapshot);
    },
  });
  registerSettingsHandlers(settings, (e) => e.sender.id === win.webContents.id);

  registerHandler("automation.focus.get", (e) => (isTrusted(e) ? automation.currentFocus() : null));
  registerHandler("automation.hide", (e) => (isOverlay(e) ? automation.userHide() : false));
  registerHandler("automation.resize", (e, msg: { phase?: string; edge?: string; dx?: number; dy?: number }) => {
    if (!isOverlay(e) || !msg) return;
    const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    const phase = msg.phase === "start" || msg.phase === "move" || msg.phase === "end" ? msg.phase : null;
    if (!phase || !edges.includes(String(msg.edge))) return;
    const dx = Number(msg.dx);
    const dy = Number(msg.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    overlay.resizeBy(phase, msg.edge as "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw", dx, dy);
  });
  registerHandler("automation.setCollapsed", (e, collapsed: boolean) => {
    if (isOverlay(e)) overlay.setCollapsed(collapsed === true);
  });
  registerHandler("automation.openMainWindow", (e) => {
    if (!isOverlay(e) || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

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

  // Model providers (Settings). Created before preflight so the agent-endpoint check reports the
  // provider actually in use, and before any model call is possible. On the very first run this
  // imports AGENT_BASE_URL / AGENT_API_KEY from .env once.
  providers = new ProviderStore({
    filePath: path.join(app.getPath("userData"), "providers.json"),
    cipher: safeStorageCipher,
    importModel: config.defaultModel,
    log: (line) => console.log(`[providers] ${line}`),
  });
  installEndpointResolver({
    active: () => providers?.resolveActive() ?? null,
    describeMissing: () => {
      const name = providers?.list().find((p) => p.active)?.name ?? "the selected provider";
      return `No API key is saved for ${name}. Open Settings (the gear in the top bar) and add one.`;
    },
  });

  const extraChecks = config.voiceEnabled
    ? [
        { name: "voice-hotkey", ...probeHotkey(config.voiceHotkey) },
        isValidModelName(config.voiceModel)
          ? voiceModelCheck(modelPath(voiceDir(), config.voiceModel))
          : { name: "voice-model", passed: false, detail: `invalid voiceModel "${config.voiceModel}"` },
      ]
    : [];
  const activeProvider = providers.list().find((p) => p.active);
  const preflight = await runPreflight({
    mcpServer,
    extraChecks,
    agent: activeProvider ? { name: activeProvider.name, baseUrl: activeProvider.baseUrl, hasKey: activeProvider.hasKey } : undefined,
  });
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
  automationOverlay?.destroy();
  void mcp?.stop();
});
