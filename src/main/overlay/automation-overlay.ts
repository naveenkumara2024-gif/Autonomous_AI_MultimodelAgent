import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { OverlayPort } from "./automation-controller";
import { type Point, pickDodgeBounds, type Rect, rectContains, restoreBounds } from "./overlay-geometry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SIZE = { width: 420, height: 540 };
const MIN_SIZE = { width: 300, height: 160 };
const COLLAPSED_HEIGHT = 44;
const MARGIN = 16;
const RAISE_INTERVAL_MS = 2000;
const SAVE_DEBOUNCE_MS = 400;

interface SavedState extends Rect {
  collapsed: boolean;
}

/**
 * The always-on-top automation overlay (prompts/automation-overlay.md): live trace steps and
 * approvals above whatever app the agent is driving. A second BrowserWindow, created lazily on
 * first use and then kept (hidden) so later shows are instant.
 *
 * Deliberately NOT transparent (transparent windows can't be resized on Windows) and NOT
 * focusable (WS_EX_NOACTIVATE): the agent types real keystrokes into whatever app has focus,
 * so pressing Approve here must never move focus onto this window. It is also excluded from
 * screen capture, so the model never sees it and never picks it as a click target.
 */
export class AutomationOverlay implements OverlayPort {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private collapsed = false;
  private expandedHeight = DEFAULT_SIZE.height;
  private raiseTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly statePath: string) {}

  get webContentsId(): number | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.id : null;
  }

  private readState(): SavedState | null {
    try {
      if (!existsSync(this.statePath)) return null;
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as Partial<SavedState>;
      if (![parsed.x, parsed.y, parsed.width, parsed.height].every((v) => typeof v === "number")) return null;
      return { x: parsed.x!, y: parsed.y!, width: parsed.width!, height: parsed.height!, collapsed: parsed.collapsed === true };
    } catch {
      return null;
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const saved = this.readState();
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    const bounds = restoreBounds(saved, workAreas, screen.getPrimaryDisplay().workArea, DEFAULT_SIZE, MIN_SIZE, MARGIN);
    this.collapsed = saved?.collapsed ?? false;
    // The saved height is always the expanded one (see scheduleSave), so a restart can expand.
    this.expandedHeight = Math.max(MIN_SIZE.height, bounds.height);

    const win = new BrowserWindow({
      ...bounds,
      height: this.collapsed ? COLLAPSED_HEIGHT : bounds.height,
      minWidth: MIN_SIZE.width,
      minHeight: this.collapsed ? COLLAPSED_HEIGHT : MIN_SIZE.height,
      show: false,
      frame: false,
      transparent: false,
      resizable: !this.collapsed,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // see the class comment: Approve must never steal focus from the target app
      hasShadow: true,
      backgroundColor: "#0f0f10",
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setContentProtection(true);

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
    });
    win.on("move", () => this.scheduleSave());
    win.on("resize", () => this.scheduleSave());
    win.on("closed", () => {
      this.window = null;
      this.loaded = false;
      this.stopRaising();
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const load = devServerUrl
      ? win.loadURL(`${devServerUrl}#automation`)
      : win.loadFile(path.join(__dirname, "../../dist/index.html"), { hash: "automation" });
    load.catch((error) => console.error(`[overlay] failed to load: ${error instanceof Error ? error.message : error}`));

    this.window = win;
    return win;
  }

  show(): void {
    const win = this.ensureWindow();
    win.showInactive();
    this.raise();
    this.startRaising();
  }

  hide(): void {
    this.stopRaising();
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  /** Re-assert the top-most position without activating the window. */
  raise(): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  }

  containsCursor(): boolean {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    return rectContains(win.getBounds(), screen.getCursorScreenPoint());
  }

  send(channel: string, payload: unknown): void {
    // Before the page has loaded it pulls its state itself (automation.focus.get), so dropping is safe.
    if (this.window && !this.window.isDestroyed() && this.loaded) this.window.webContents.send(channel, payload);
  }

  /** Header collapse button: shrink to the one-line strip, or restore the previous height. */
  setCollapsed(collapsed: boolean): void {
    const win = this.window;
    if (!win || win.isDestroyed() || collapsed === this.collapsed) return;
    const { width } = win.getBounds();
    this.collapsed = collapsed;
    if (collapsed) {
      this.expandedHeight = Math.max(MIN_SIZE.height, win.getBounds().height);
      win.setMinimumSize(MIN_SIZE.width, COLLAPSED_HEIGHT);
      win.setResizable(false);
      win.setSize(width, COLLAPSED_HEIGHT);
    } else {
      win.setMinimumSize(MIN_SIZE.width, MIN_SIZE.height);
      win.setResizable(true);
      win.setSize(width, this.expandedHeight);
    }
    this.scheduleSave();
  }

  /**
   * The agent needs a point this window is covering (physical screen pixels from the MCP
   * server). Move to the farthest clear corner of that display. false = it wasn't covering the
   * point, or nowhere clears it.
   */
  dodge(physicalPoint: Point): boolean {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    const point = screen.screenToDipPoint(physicalPoint);
    const bounds = win.getBounds();
    if (!rectContains(bounds, point)) return false;
    const next = pickDodgeBounds(point, bounds, screen.getDisplayNearestPoint(point).workArea, MARGIN);
    if (!next) return false;
    win.setBounds(next);
    this.scheduleSave();
    return true;
  }

  destroy(): void {
    this.stopRaising();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private startRaising(): void {
    if (this.raiseTimer) return;
    this.raiseTimer = setInterval(() => this.raise(), RAISE_INTERVAL_MS);
  }

  private stopRaising(): void {
    if (this.raiseTimer) clearInterval(this.raiseTimer);
    this.raiseTimer = null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const win = this.window;
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      // Remember the expanded height even while collapsed, so a restart restores the full size.
      const state: SavedState = { x: b.x, y: b.y, width: b.width, height: this.collapsed ? this.expandedHeight : b.height, collapsed: this.collapsed };
      try {
        writeFileSync(this.statePath, JSON.stringify(state), "utf-8");
      } catch (error) {
        console.error(`[overlay] could not save window state: ${error instanceof Error ? error.message : error}`);
      }
    }, SAVE_DEBOUNCE_MS);
  }
}
