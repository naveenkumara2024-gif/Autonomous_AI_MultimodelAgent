import { ChevronDown, ChevronUp, ExternalLink, Loader2, ShieldAlert, Square, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABEL, primaryDetail, SUBAGENT_LABEL, useCountdown } from "./ApprovalDialog";
import { buildTurnView, formatMs, type NoteRow, type ToolRow } from "./TracePanel";
import { Button } from "./components/ui/button";
import { useSessionMessageEvent, useSessionUpdateEvent } from "./hooks/useIPC";
import { useTheme } from "./hooks/useTheme";
import { useApprovals, useTrace } from "./hooks/useTrace";
import { cn } from "./lib/utils";
import type { ApprovalRequest, Message, Session } from "./types";

// The always-on-top automation overlay (route "#automation"; main/overlay/*). Live steps of the
// turn the agent is running, plus any pending approval, so the user can watch the target app
// and the agent at the same time. Pure display: every decision (show/hide/minimize) is made in
// main/overlay/automation-controller.ts and arrives as events.

const DRAG: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** The window is "collapsed" to its header strip when it is no taller than this (main sets 44). */
const COLLAPSED_MAX_HEIGHT = 64;

const DOT: Record<ToolRow["status"], string> = {
  running: "bg-status-running animate-pulse",
  "awaiting-approval": "bg-status-stopped animate-pulse",
  ok: "bg-status-idle",
  error: "bg-destructive",
  denied: "bg-status-stopped",
  cancelled: "bg-muted-foreground",
};

type Phase = "idle" | "working" | "approval" | "done" | "stopped" | "blocked" | "failed";

function useWindowHeight(): number {
  const [height, setHeight] = useState(window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

// Thin on the sides so they don't swallow the scrollbar; corners are larger targets.
const HANDLES: Array<{ edge: Edge; className: string }> = [
  { edge: "n", className: "left-3 right-3 top-0 h-1 cursor-ns-resize" },
  { edge: "s", className: "bottom-0 left-3 right-3 h-1 cursor-ns-resize" },
  { edge: "w", className: "bottom-3 left-0 top-3 w-1 cursor-ew-resize" },
  { edge: "e", className: "bottom-3 right-0 top-3 w-1 cursor-ew-resize" },
  { edge: "nw", className: "left-0 top-0 size-3 cursor-nwse-resize" },
  { edge: "ne", className: "right-0 top-0 size-3 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { edge: "se", className: "bottom-0 right-0 size-4 cursor-nwse-resize" },
];

/**
 * Edge and corner resize handles. Windows' own resize band for a frameless window lies OUTSIDE
 * the painted edge, so pressing the visible edge reached the page and nothing resized. These
 * handles sit on the visible edge and report the drag to main (screen-coordinate deltas, so
 * they are unaffected by the window moving under the pointer while it is resized from the
 * left/top). They also override the header's drag region along the top edge.
 */
function ResizeHandles() {
  const drag = useRef<{ edge: Edge; startX: number; startY: number } | null>(null);
  const pending = useRef<{ dx: number; dy: number } | null>(null);
  const frame = useRef<number | null>(null);

  const send = (phase: "start" | "move" | "end", edge: Edge, dx: number, dy: number) => {
    void window.agentBridge.resizeAutomationOverlay({ phase, edge, dx, dy }).catch(() => {});
  };

  const flush = () => {
    frame.current = null;
    const d = drag.current;
    const p = pending.current;
    if (d && p) send("move", d.edge, p.dx, p.dy);
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    send("end", d.edge, 0, 0);
  };

  return (
    <>
      {HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          style={NO_DRAG}
          className={cn("absolute z-50 touch-none", className)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { edge, startX: e.screenX, startY: e.screenY };
            send("start", edge, 0, 0);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            pending.current = { dx: e.screenX - d.startX, dy: e.screenY - d.startY };
            if (frame.current === null) frame.current = requestAnimationFrame(flush);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      ))}
      {/* A visible grip so the window reads as resizable. */}
      <svg className="pointer-events-none absolute bottom-0.5 right-0.5 z-40 size-3 text-muted-foreground/60" viewBox="0 0 12 12" aria-hidden>
        <path d="M11 3 3 11M11 7 7 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      </svg>
    </>
  );
}

function replyFor(messages: Message[], turnId: string): string | null {
  const start = messages.findIndex((m) => m.id === turnId);
  if (start < 0) return null;
  return messages.slice(start + 1).find((m) => m.role === "assistant")?.content ?? null;
}

function StepRow({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const note = row.approval === "denied" ? "denied" : row.approval === "timeout" ? "timed out" : null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent">
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT[row.status])} />
        <span className="shrink-0 font-mono text-[11px] font-medium text-foreground">{row.tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.intent}</span>
        {note && <span className="shrink-0 rounded border border-current px-1 text-[9px] uppercase text-status-stopped">{note}</span>}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{row.status === "awaiting-approval" ? "waiting" : formatMs(row.ms)}</span>
      </button>
      {!open && row.summary && <div className="truncate pl-6 pr-1.5 font-mono text-[10px] text-muted-foreground">⎿ {row.summary}</div>}
      {open && (
        <div className="mb-1 ml-5 space-y-1 border-l border-border pl-2 text-[10px]">
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5 font-mono select-text">{JSON.stringify(row.args, null, 2)}</pre>
          {row.result && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1.5 font-mono select-text">{row.result}</pre>}
        </div>
      )}
    </div>
  );
}

function NoteLine({ note }: { note: NoteRow }) {
  return <div className={cn("whitespace-pre-wrap px-1.5 py-0.5 text-[11px]", note.tone === "error" ? "text-destructive" : "text-muted-foreground")}>{note.text}</div>;
}

function ApprovalCard({ request, total, sessionTitle }: { request: ApprovalRequest; total: number; sessionTitle?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(request.expiresAt);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [request.id]);

  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.agentBridge.respondApproval(request.id, approved);
    } catch (e) {
      // A failed answer must never leave both buttons disabled for good.
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
      setBusy(false);
      return;
    }
    // Main resolves the request and pushes "approval.resolved", which removes this card. If that
    // ever doesn't happen (the card is stale), the buttons come back instead of staying dead.
    window.setTimeout(() => setBusy(false), 4000);
  };

  const detail = primaryDetail(request);
  const categories = request.risk.categories.length ? request.risk.categories : request.risk.category ? [request.risk.category] : [];

  return (
    <div
      className="mx-2 mb-2 flex max-h-[65%] min-h-0 shrink-0 flex-col rounded-lg border border-status-stopped/60 bg-card shadow-sm"
      role="alertdialog"
      aria-label="Approve this action?"
    >
      {/* The details scroll when the window is short; Deny / Approve below stay pinned in view. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-stopped" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-foreground">Approve this action?</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {SUBAGENT_LABEL[request.subagent] ?? request.subagent} wants to run <span className="font-mono text-foreground">{request.tool}</span>
            {total > 1 ? ` · 1 of ${total}` : ""}
            {sessionTitle ? ` · ${sessionTitle}` : ""}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title="Denied automatically when this reaches 0">
          {countdown}
        </span>
      </div>

      {request.intent && <div className="mt-1.5 text-[11px] text-foreground">“{request.intent}”</div>}
      {categories.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {categories.map((c) => (
            <span key={c} className="rounded border border-current px-1.5 text-[9px] font-medium uppercase tracking-wide text-status-stopped">
              {CATEGORY_LABEL[c] ?? c}
            </span>
          ))}
        </div>
      )}
      {request.risk.reasons.length > 0 && <div className="mt-1.5 text-[11px] text-muted-foreground">{request.risk.reasons.join("; ")}</div>}
      {detail && <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted p-1.5 font-mono text-[10px] text-foreground select-text">{detail.value}</pre>}
      {error && <div className="mt-1.5 text-[11px] text-destructive">Couldn&apos;t send your answer: {error}</div>}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-2.5 py-2">
        <Button type="button" variant="secondary" size="sm" className="h-7" disabled={busy} onClick={() => void respond(false)}>
          Deny
        </Button>
        <Button type="button" variant="destructive" size="sm" className="h-7" disabled={busy} onClick={() => void respond(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export function AutomationOverlay() {
  useTheme();
  const [focus, setFocus] = useState<{ sessionId: string; turnId: string } | null>(null);
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [planOpen, setPlanOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const height = useWindowHeight();
  const collapsed = height <= COLLAPSED_MAX_HEIGHT;

  // Which turn to follow: pulled once on load (events sent before the page loaded are dropped),
  // then pushed by main whenever a turn starts.
  useEffect(() => {
    if (!window.agentBridge) return;
    void window.agentBridge.getAutomationFocus().then((f) => f && setFocus(f));
    return window.agentBridge.onSessionEvent("automation.focus", (payload) => setFocus(payload as { sessionId: string; turnId: string }));
  }, []);

  useEffect(() => {
    if (!window.agentBridge) return;
    void window.agentBridge.listSessions().then((list) => setSessions(Object.fromEntries(list.map((s) => [s.id, s.title]))));
  }, []);
  useSessionUpdateEvent(
    useCallback((s: Partial<Session> & { id: string; deleted?: boolean }) => {
      setSessions((prev) => (s.title ? { ...prev, [s.id]: s.title } : prev));
    }, []),
  );

  useEffect(() => {
    setMessages([]);
    if (!focus || !window.agentBridge) return;
    let cancelled = false;
    void window.agentBridge.listMessages(focus.sessionId).then((list) => !cancelled && setMessages(list));
    return () => {
      cancelled = true;
    };
  }, [focus?.sessionId, focus?.turnId]);
  useSessionMessageEvent(
    useCallback(
      (message: Message) => {
        if (message.sessionId !== focus?.sessionId) return;
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      },
      [focus?.sessionId],
    ),
  );

  const allEvents = useTrace(focus?.sessionId ?? null);
  const events = useMemo(() => (focus ? allEvents.filter((e) => e.turnId === focus.turnId) : []), [allEvents, focus]);
  const view = useMemo(() => buildTurnView(events), [events]);
  const approvals = useApprovals();

  const steps = useMemo(() => {
    const out: Array<ToolRow | NoteRow> = [];
    for (const item of view.timeline) {
      if (item.kind === "group") out.push(...item.items.filter((i) => i.kind === "tool" || i.tone === "error"));
      else if (item.kind === "tool" || item.tone === "error" || item.actor === "system") out.push(item);
    }
    return out;
  }, [view]);
  const toolCount = steps.filter((s) => s.kind === "tool").length;

  const running = view.startTs !== undefined && view.endTs === undefined;
  const now = useNow(running);
  const phase: Phase =
    approvals.length > 0 ? "approval" : running ? "working" : view.status === "done" ? "done" : view.status === "cancelled" ? "stopped" : view.status === "blocked" ? "blocked" : view.status ? "failed" : "idle";

  // A collapsed strip has no Approve/Deny, so a pending approval expands it.
  const needsApproval = approvals.length > 0;
  useEffect(() => {
    if (collapsed && needsApproval) void window.agentBridge.setAutomationCollapsed(false);
  }, [collapsed, needsApproval]);

  const reply = !running && focus ? replyFor(messages, focus.turnId) : null;
  const title = focus ? sessions[focus.sessionId] : undefined;
  const elapsed = view.startTs ? formatMs((view.endTs ?? now) - view.startTs) : "";

  // Keep the newest step in view unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [steps.length, reply, approvals.length]);

  const label: Record<Phase, string> = {
    idle: "Ready",
    working: "Working…",
    approval: "Needs your approval",
    done: `Done${elapsed ? ` · ${elapsed}` : ""}`,
    stopped: "Stopped",
    blocked: "Blocked",
    failed: "Failed",
  };
  const dot: Record<Phase, string> = {
    idle: "bg-muted-foreground",
    working: "bg-status-running animate-pulse",
    approval: "bg-status-stopped animate-pulse",
    done: "bg-status-idle",
    stopped: "bg-muted-foreground",
    blocked: "bg-status-stopped",
    failed: "bg-destructive",
  };

  const checklistDone = view.checklist.filter((c) => c.status === "done").length;
  const approval = approvals[0];

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden border border-border bg-background text-[12px] text-foreground select-none">
      {!collapsed && <ResizeHandles />}
      <header className="flex h-11 shrink-0 items-center gap-2 px-3" style={DRAG}>
        <span className={cn("size-2 shrink-0 rounded-full", dot[phase])} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold leading-tight">{label[phase]}</div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground">
            {title && title !== "New session" ? `${title} · ` : ""}
            {toolCount} step{toolCount === 1 ? "" : "s"}
            {running && elapsed ? ` · ${elapsed}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" style={NO_DRAG}>
          {running && focus && (
            <Button type="button" variant="secondary" size="sm" className="mr-1 h-6 gap-1 px-2" onClick={() => void window.agentBridge.cancelTurn(focus.sessionId)}>
              <Square className="!size-2.5 fill-current" /> Stop
            </Button>
          )}
          <button type="button" title="Open the app window" onClick={() => void window.agentBridge.openMainWindow()} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ExternalLink className="size-3.5" />
          </button>
          <button
            type="button"
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => void window.agentBridge.setAutomationCollapsed(!collapsed)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button
            type="button"
            title={approvals.length ? "Answer the approval first" : "Hide"}
            disabled={approvals.length > 0}
            onClick={() => void window.agentBridge.hideAutomationOverlay()}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          {approval && <ApprovalCard request={approval} total={approvals.length} sessionTitle={sessions[approval.sessionId] !== title ? sessions[approval.sessionId] : undefined} />}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto border-t border-border px-1.5 py-1.5 [scrollbar-width:thin]">
            {view.checklist.length > 1 && (
              <div className="mb-1 rounded border border-border">
                <button type="button" onClick={() => setPlanOpen((v) => !v)} className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground">
                  {planOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  Plan · {checklistDone}/{view.checklist.length} done
                </button>
                {planOpen && (
                  <div className="space-y-0.5 border-t border-border px-2 py-1">
                    {view.checklist.map((item) => (
                      <div key={item.id} className={cn("flex gap-1.5 text-[11px]", item.status === "done" && "text-muted-foreground line-through")}>
                        <span className="w-3 shrink-0 text-center font-mono">{item.status === "done" ? "✓" : item.status === "failed" ? "✕" : item.status === "blocked" ? "⊘" : "○"}</span>
                        <span>{item.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {steps.map((step) => (step.kind === "tool" ? <StepRow key={step.id} row={step} /> : <NoteLine key={step.id} note={step} />))}

            {running && steps.length === 0 && (
              <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Planning…
              </div>
            )}
            {!focus && !approval && <div className="px-1.5 py-2 text-[11px] text-muted-foreground">Waiting for the agent to start.</div>}

            {reply && <div className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card px-2 py-1.5 text-[12px] text-foreground select-text">{reply}</div>}
          </div>
        </>
      )}
    </div>
  );
}
