import { beforeEach, describe, expect, test } from "bun:test";
import type { TraceEvent } from "../agent/trace";
import type { ApprovalRequest } from "../sandbox/approval-gate";
import { AutomationController, type TimerPort } from "./automation-controller";

class FakeTimers implements TimerPort {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
}

function setup(opts: { enabled?: boolean; minimize?: boolean; mainOnScreen?: boolean } = {}) {
  const timers = new FakeTimers();
  const calls: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const state = { cursorOver: false, mainOnScreen: opts.mainOnScreen ?? true, enabled: opts.enabled ?? true };
  const controller = new AutomationController({
    overlay: {
      show: () => calls.push("show"),
      hide: () => calls.push("hide"),
      raise: () => calls.push("raise"),
      containsCursor: () => state.cursorOver,
      send: (channel, payload) => sent.push([channel, payload]),
    },
    mainWindow: { isOnScreen: () => state.mainOnScreen, minimize: () => calls.push("minimize-main") },
    enabled: () => state.enabled,
    minimizeMainWindow: () => opts.minimize ?? true,
    timers,
    showDelayMs: 300,
    autoHideMs: 8000,
  });
  return { controller, timers, calls, sent, state };
}

let seq = 0;
const trace = (type: TraceEvent["type"], data: Record<string, unknown> = {}, sessionId = "s1", turnId = "t1"): TraceEvent => ({
  id: `e${++seq}`,
  sessionId,
  turnId,
  parentId: null,
  seq,
  ts: seq,
  type,
  actor: "system",
  data,
});

const approval = (id = "a1", sessionId = "s1"): ApprovalRequest =>
  ({ id, sessionId, turnId: "t1", subagent: "shell", tool: "run_powershell", intent: "", args: {}, risk: {}, requestedAt: 0, expiresAt: 1 }) as unknown as ApprovalRequest;

const startTurn = (c: AutomationController) => c.observe("trace.event", trace("agent_start"));
const toolStart = (c: AutomationController) => c.observe("trace.event", trace("tool_execution_start", { tool: "click" }));
const endTurn = (c: AutomationController, status = "done") => c.observe("trace.event", trace("agent_end", { status }));

beforeEach(() => {
  seq = 0;
});

describe("showing", () => {
  test("a pure chat turn with no tool call never shows it", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    endTurn(controller);
    timers.advance(10_000);
    expect(calls).toEqual([]);
  });

  test("appears only after the show delay, then minimizes the main window once", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    toolStart(controller);
    timers.advance(299);
    expect(calls).toEqual([]);
    timers.advance(1);
    expect(calls).toEqual(["show", "minimize-main"]);
    toolStart(controller);
    expect(calls).toEqual(["show", "minimize-main", "raise"]);
  });

  test("a turn that ends inside the delay (a fast path) never flashes it", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    toolStart(controller);
    timers.advance(200);
    endTurn(controller);
    timers.advance(10_000);
    expect(calls).toEqual([]);
  });

  test("tells the overlay which turn to follow", () => {
    const { controller, sent } = setup();
    startTurn(controller);
    expect(sent).toContainEqual(["automation.focus", { sessionId: "s1", turnId: "t1" }]);
    expect(controller.currentFocus()).toEqual({ sessionId: "s1", turnId: "t1" });
  });

  test("ignores tool calls from a session it is not following", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    controller.observe("trace.event", trace("tool_execution_start", {}, "other-session", "t9"));
    timers.advance(1000);
    expect(calls).toEqual([]);
  });
});

describe("main window", () => {
  test("is left alone when minimizing is turned off", () => {
    const { controller, timers, calls } = setup({ minimize: false });
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    expect(calls).toEqual(["show"]);
  });

  test("is left alone when the user already minimized it", () => {
    const { controller, timers, calls } = setup({ mainOnScreen: false });
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    expect(calls).toEqual(["show"]);
  });

  test("is not restored when the turn ends", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    endTurn(controller);
    timers.advance(60_000);
    expect(calls.filter((c) => c.includes("main") && c !== "minimize-main")).toEqual([]);
  });
});

describe("disabled", () => {
  test("shows nothing and minimizes nothing, even for an approval", () => {
    const { controller, timers, calls } = setup({ enabled: false });
    startTurn(controller);
    toolStart(controller);
    controller.observe("approval.request", approval());
    timers.advance(10_000);
    expect(calls).toEqual([]);
  });
});

describe("approvals", () => {
  test("show immediately, without waiting for the delay", () => {
    const { controller, calls } = setup();
    startTurn(controller);
    controller.observe("approval.request", approval());
    expect(calls).toEqual(["show", "minimize-main"]);
  });

  test("bring back an overlay the user dismissed", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    expect(controller.userHide()).toBe(true);
    calls.length = 0;
    controller.observe("approval.request", approval());
    expect(calls).toContain("show");
  });

  test("cannot be dismissed while one is pending", () => {
    const { controller, calls } = setup();
    startTurn(controller);
    controller.observe("approval.request", approval());
    calls.length = 0;
    expect(controller.userHide()).toBe(false);
    expect(calls).toEqual([]);
    expect(controller.isShown).toBe(true);
  });

  test("can be dismissed again once answered", () => {
    const { controller } = setup();
    startTurn(controller);
    controller.observe("approval.request", approval("a1"));
    controller.observe("approval.resolved", { id: "a1", sessionId: "s1", outcome: "approved" });
    expect(controller.userHide()).toBe(true);
  });
});

describe("hiding", () => {
  const shownAndDone = (status = "done") => {
    const s = setup();
    startTurn(s.controller);
    toolStart(s.controller);
    s.timers.advance(300);
    endTurn(s.controller, status);
    s.calls.length = 0;
    return s;
  };

  test("auto-hides 8 s after a successful turn", () => {
    const { timers, calls } = shownAndDone();
    timers.advance(7999);
    expect(calls).toEqual([]);
    timers.advance(1);
    expect(calls).toEqual(["hide"]);
  });

  test("stays up after a blocked, failed or cancelled turn", () => {
    for (const status of ["blocked", "error", "cancelled"]) {
      const { timers, calls } = shownAndDone(status);
      timers.advance(60_000);
      expect(calls).toEqual([]);
    }
  });

  test("waits while the pointer is over it", () => {
    const { timers, calls, state } = shownAndDone();
    state.cursorOver = true;
    timers.advance(8000);
    expect(calls).toEqual([]);
    state.cursorOver = false;
    timers.advance(8000);
    expect(calls).toEqual(["hide"]);
  });

  test("a new turn cancels a pending auto-hide", () => {
    const { controller, timers, calls } = shownAndDone();
    timers.advance(4000);
    startTurn(controller);
    timers.advance(60_000);
    expect(calls).toEqual([]);
  });

  test("a dismissed overlay stays hidden for the rest of the turn, and returns next turn", () => {
    const { controller, timers, calls } = setup();
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    controller.userHide();
    calls.length = 0;
    toolStart(controller);
    timers.advance(1000);
    expect(calls).toEqual([]);

    endTurn(controller);
    startTurn(controller);
    toolStart(controller);
    timers.advance(300);
    expect(calls).toContain("show");
  });
});
