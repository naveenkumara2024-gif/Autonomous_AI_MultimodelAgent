import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { OverlayPort } from "./automation-controller";
import { type Point, pickDodgeBounds, type Rect, rectContains, type ResizeEdge, resizeBounds, restoreBounds } from "./overlay-geometry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SIZE = { width: 420, height: 540 };
const MIN_SIZE = { width: 300, height: 160 };
const COLLAPSED_HEIGHT = 44;
const MARGIN = 16;
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
 *
 * It must also never be ACTIVATED by our own code. Electron's win.moveTop() is
 * SetWindowPos(HWND_TOP) WITHOUT SWP_NOACTIVATE, so calling it (as an earlier version did on a
 * 2 s timer and at every tool call) made the overlay the foreground window: the agent's
 * keystrokes and UI Automation then targeted the overlay, and the Electron UI thread that
 * serves the user's clicks was busy answering accessibility queries — the overlay would not move
 * or respond to buttons while automation ran. Topmost windows stay above normal ones on their
 * own, so the only z-order call here is setAlwaysOnTop at creation, before the first show.
 */
export class AutomationOverlay implements OverlayPort {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private collapsed = false;
  private expandedHeight = DEFAULT_SIZE.height;
  /** Events sent before the page finished loading; replayed (in order) once it has. */
  private pending: Array<[string, unknown]> = [];
  private resizeStart: Rect | null = null;
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
    // Should never happen (focusable: false); if anything ever does activate it, say so loudly
    // instead of leaving the agent typing into the overlay.
    win.on("focus", () => console.warn("[overlay] the automation overlay took keyboard focus — it must never be activated"));

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      // Whatever arrived while the page was loading (an approval, a trace row) is replayed now;
      // the renderer de-duplicates by id, so overlap with its own initial pull is harmless.
      const queued = this.pending;
      this.pending = [];
      for (const [channel, payload] of queued) if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
    win.on("move", () => this.scheduleSave());
    win.on("resize", () => this.scheduleSave());
    win.on("closed", () => {
      this.window = null;
      this.loaded = false;
      this.pending = [];
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
    // showInactive: shown, never activated. (No raise/moveTop here — see the class comment.)
    this.ensureWindow().showInactive();
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  /**
   * Called on tool starts. Deliberately does not touch z-order unless "always on top" has
   * actually been cleared, and never uses moveTop (which activates the window).
   */
  raise(): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, "screen-saver");
  }

  containsCursor(): boolean {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    return rectContains(win.getBounds(), screen.getCursorScreenPoint());
  }

  send(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.loaded) {
      this.window.webContents.send(channel, payload);
      return;
    }
    // The page is still loading: it pulls its initial state itself, but anything that happens
    // between that pull and the load finishing would be lost, so hold it (bounded) and replay.
    this.pending.push([channel, payload]);
    if (this.pending.length > 500) this.pending.shift();
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
   * Edge/corner resize driven from the page. The window's native resize band sits OUTSIDE the
   * painted edge (an invisible ~8 px border), so users pressing the visible edge hit the page
   * instead; the page draws its own handles and reports drags here.
   */
  resizeBy(phase: "start" | "move" | "end", edge: ResizeEdge, dx: number, dy: number): void {
    const win = this.window;
    if (!win || win.isDestroyed() || this.collapsed) return;
    if (phase === "end") {
      this.resizeStart = null;
      return;
    }
    if (phase === "start" || !this.resizeStart) this.resizeStart = win.getBounds();
    const work = screen.getDisplayMatching(this.resizeStart).workArea;
    win.setBounds(resizeBounds(this.resizeStart, edge, dx, dy, MIN_SIZE, { width: work.width, height: work.height }));
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
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
