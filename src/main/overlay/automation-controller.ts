import type { TraceEvent } from "../agent/trace";
import type { ApprovalRequest } from "../sandbox/approval-gate";

/**
 * Decides when the automation overlay shows, hides and minimizes the main window
 * (prompts/automation-overlay.md decisions 5, 6, 8, 9). It only observes the event stream main
 * already emits to the renderer — agent code is untouched — and drives the window through a
 * small port, so every rule here is unit-tested without Electron.
 */

export interface OverlayPort {
  show(): void;
  hide(): void;
  /** Re-assert top-most position (another app may have claimed it). */
  raise(): void;
  /** Whether the mouse pointer is currently over the overlay. */
  containsCursor(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface MainWindowPort {
  /** Visible and neither minimized nor destroyed — i.e. something minimizing would change. */
  isOnScreen(): boolean;
  minimize(): void;
}

export interface TimerPort {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AutomationControllerOptions {
  overlay: OverlayPort;
  mainWindow: MainWindowPort;
  enabled: () => boolean;
  minimizeMainWindow: () => boolean;
  timers?: TimerPort;
  /** A tool must still be running this long after it starts before the overlay appears. */
  showDelayMs?: number;
  /** After a successful turn the overlay hides itself this long later (paused while hovered). */
  autoHideMs?: number;
}

export interface OverlayFocus {
  sessionId: string;
  turnId: string;
}

const SHOW_DELAY_MS = 300;
const AUTO_HIDE_MS = 8000;

const realTimers: TimerPort = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AutomationController {
  private readonly showDelayMs: number;
  private readonly autoHideMs: number;
  private readonly timers: TimerPort;
  private readonly pendingApprovals = new Set<string>();
  private focus: OverlayFocus | null = null;
  private shown = false;
  /** The user dismissed the overlay during this turn; only an approval brings it back. */
  private dismissed = false;
  private showTimer: unknown = null;
  private hideTimer: unknown = null;

  constructor(private readonly options: AutomationControllerOptions) {
    this.showDelayMs = options.showDelayMs ?? SHOW_DELAY_MS;
    this.autoHideMs = options.autoHideMs ?? AUTO_HIDE_MS;
    this.timers = options.timers ?? realTimers;
  }

  /** The turn the overlay is following (it pulls this when its page first loads). */
  currentFocus(): OverlayFocus | null {
    return this.focus;
  }

  get isShown(): boolean {
    return this.shown;
  }

  /** Feed every event main broadcasts to the renderer. */
  observe(channel: string, payload: unknown): void {
    if (channel === "trace.event") this.onTrace(payload as TraceEvent);
    else if (channel === "approval.request") this.onApprovalRequest(payload as ApprovalRequest);
    else if (channel === "approval.resolved") this.pendingApprovals.delete((payload as { id: string }).id);
  }

  /**
   * The user pressed hide. Refused while an approval is pending — it would leave a flagged
   * action blocked with nowhere visible to answer it.
   */
  userHide(): boolean {
    if (this.pendingApprovals.size > 0) return false;
    this.clearTimers();
    this.dismissed = true;
    this.hideNow();
    return true;
  }

  dispose(): void {
    this.clearTimers();
  }

  private onTrace(event: TraceEvent): void {
    switch (event.type) {
      case "agent_start":
        this.focus = { sessionId: event.sessionId, turnId: event.turnId };
        this.dismissed = false;
        this.clearTimers();
        this.options.overlay.send("automation.focus", this.focus);
        break;

      case "tool_execution_start":
        if (!this.options.enabled() || this.focus?.sessionId !== event.sessionId) break;
        if (this.shown) this.options.overlay.raise();
        else if (!this.dismissed && this.showTimer === null) {
          this.showTimer = this.timers.set(() => {
            this.showTimer = null;
            this.showNow();
          }, this.showDelayMs);
        }
        break;

      case "agent_end":
        if (this.focus?.sessionId !== event.sessionId) break;
        // A turn that finished inside the show delay never needed the overlay.
        this.cancelShowTimer();
        if (this.shown && event.data.status === "done") this.scheduleAutoHide();
        break;
    }
  }

  private onApprovalRequest(request: ApprovalRequest): void {
    this.pendingApprovals.add(request.id);
    if (!this.options.enabled()) return;
    // Whatever the user did earlier: a pending approval must always be answerable somewhere.
    this.dismissed = false;
    this.cancelHideTimer();
    this.showNow();
  }

  private showNow(): void {
    if (!this.options.enabled()) return;
    this.cancelShowTimer();
    if (!this.shown) {
      this.shown = true;
      this.options.overlay.show();
      if (this.options.minimizeMainWindow() && this.options.mainWindow.isOnScreen()) this.options.mainWindow.minimize();
    } else {
      this.options.overlay.raise();
    }
    if (this.focus) this.options.overlay.send("automation.focus", this.focus);
  }

  private hideNow(): void {
    if (!this.shown) return;
    this.shown = false;
    this.options.overlay.hide();
  }

  private scheduleAutoHide(): void {
    this.cancelHideTimer();
    this.hideTimer = this.timers.set(() => {
      this.hideTimer = null;
      // Hovering counts as "still reading it"; a pending approval must stay answerable.
      if (this.pendingApprovals.size > 0 || this.options.overlay.containsCursor()) this.scheduleAutoHide();
      else this.hideNow();
    }, this.autoHideMs);
  }

  private cancelShowTimer(): void {
    if (this.showTimer !== null) this.timers.clear(this.showTimer);
    this.showTimer = null;
  }

  private cancelHideTimer(): void {
    if (this.hideTimer !== null) this.timers.clear(this.hideTimer);
    this.hideTimer = null;
  }

  private clearTimers(): void {
    this.cancelShowTimer();
    this.cancelHideTimer();
  }
}
