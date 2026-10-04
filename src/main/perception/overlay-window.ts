import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OVERLAY_WIDTH = 320;
const OVERLAY_HEIGHT = 96;
const MARGIN = 20;

/**
 * The small always-on-top recording indicator. A second BrowserWindow rather than a layer in
 * the main window, because it must appear over whatever app the user is in. Created once at
 * boot (hidden) and shown/hidden per trigger — never recreated — so a hotkey press doesn't pay
 * window-creation latency. It also hosts the microphone capture (getUserMedia is a web API),
 * which is why it is a full renderer page (the "#overlay" route) and not a native widget.
 */
export class OverlayWindow {
  readonly window: BrowserWindow;
  private readonly ready: Promise<void>;

  constructor() {
    this.window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // never steal focus from the app the user is dictating into
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false, // keep capturing while hidden-ish / unfocused
        autoplayPolicy: "no-user-gesture-required", // lets the capture AudioContext start without a click
      },
    });
    this.window.setAlwaysOnTop(true, "screen-saver");

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    this.ready = devServerUrl
      ? this.window.loadURL(`${devServerUrl}#overlay`)
      : this.window.loadFile(path.join(__dirname, "../../dist/index.html"), { hash: "overlay" });
    this.ready.catch((error) => console.error(`[voice] overlay failed to load: ${error instanceof Error ? error.message : error}`));
  }

  get webContentsId(): number {
    return this.window.webContents.id;
  }

  send(channel: string, payload: unknown): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  show(): void {
    if (this.window.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    this.window.setBounds({
      x: workArea.x + workArea.width - OVERLAY_WIDTH - MARGIN,
      y: workArea.y + workArea.height - OVERLAY_HEIGHT - MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
    this.window.showInactive();
  }

  hide(): void {
    if (!this.window.isDestroyed()) this.window.hide();
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
