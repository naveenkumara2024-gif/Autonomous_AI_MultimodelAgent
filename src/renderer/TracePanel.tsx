import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "./lib/utils";
import type { TraceEvent } from "./types";

// Claude Code-style activity trace for one turn: the supervisor's plan, each specialist's work
// as a group of tool-call rows (intent, status, timing, approval, result), and turn totals.
// Consumes the trace events streamed by src/main/agent/trace.ts.

type RowStatus = "running" | "awaiting-approval" | "ok" | "error" | "denied" | "cancelled";

interface ToolRow {
  kind: "tool";
  id: string;
  tool: string;
  intent: string;
  args: Record<string, unknown>;
  status: RowStatus;
  ms?: number;
  result?: string;
  /** One-line summary computed by main from the full result (tool-executor summarizeResult). */
  summary?: string;
  risk?: { verdict: string; category: string | null; reasons: string[] };
  approval?: string;
  lockWaitMs?: number;
  images: Array<{ path: string }>;
  withheld?: number;
}

interface NoteRow {
  kind: "note";
  id: string;
  actor: string;
  text: string;
  tone: "normal" | "error";
}

interface SubagentGroup {
  kind: "group";
  id: string;
  actor: string;
  brief: string;
  status?: string;
  summary?: string;
  steps?: number;
  items: Array<ToolRow | NoteRow>;
}

interface ChecklistItem {
  id: string;
  text: string;
  status: "pending" | "done" | "failed" | "blocked";
}

interface TurnView {
  checklist: ChecklistItem[];
  timeline: Array<SubagentGroup | NoteRow | ToolRow>;
  llmCalls: number;
  tokens: number;
  startTs?: number;
  endTs?: number;
  status?: string;
}

export function buildTurnView(events: TraceEvent[]): TurnView {
  const view: TurnView = { checklist: [], timeline: [], llmCalls: 0, tokens: 0 };
  const groups = new Map<string, SubagentGroup>();
  const tools = new Map<string, ToolRow>();

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data;
    const group = e.parentId ? groups.get(e.parentId) : undefined;
    switch (e.type) {
      case "agent_start":
        view.startTs = e.ts;
        break;
      case "agent_end":
        view.endTs = e.ts;
        view.status = d.status;
        break;
      case "supervisor_decision":
        if (Array.isArray(d.checklist) && d.checklist.length) view.checklist = d.checklist;
        break;
      case "subagent_start": {
        const g: SubagentGroup = { kind: "group", id: e.id, actor: e.actor, brief: String(d.brief ?? ""), items: [] };
        groups.set(e.id, g);
        view.timeline.push(g);
        break;
      }
      case "subagent_end":
        if (group) Object.assign(group, { status: d.status, summary: d.summary, steps: d.steps });
        break;
      case "message_update": {
        const note: NoteRow = { kind: "note", id: e.id, actor: e.actor, text: String(d.text ?? ""), tone: "normal" };
        (group ? group.items : view.timeline).push(note);
        break;
      }
      case "error": {
        const note: NoteRow = { kind: "note", id: e.id, actor: e.actor, text: String(d.message ?? "error"), tone: "error" };
        (group ? group.items : view.timeline).push(note);
        break;
      }
      case "shortcut": {
        // Why something ran without the model: a fast path, or a replay from the action cache.
        const what = d.kind === "recipe" ? "Action cache" : `Fast path "${d.name ?? ""}"`;
        const text = `⚡ ${what}: ${String(d.result ?? "")}${d.text ? ` — ${d.text}` : ""}`;
        const tone = d.result === "aborted" ? "error" : "normal";
        view.timeline.push({ kind: "note", id: e.id, actor: "system", text, tone });
        break;
      }
      case "llm_request":
        view.llmCalls++;
        break;
      case "llm_response":
        view.tokens += Number(d.usage?.total_tokens ?? 0);
        break;
      case "tool_execution_start": {
        const row: ToolRow = { kind: "tool", id: e.id, tool: String(d.tool), intent: String(d.intent ?? ""), args: d.args ?? {}, status: "running", images: [] };
        tools.set(e.id, row);
        (group ? group.items : view.timeline).push(row);
        break;
      }
      default: {
        const row = e.parentId ? tools.get(e.parentId) : undefined;
        if (!row) break;
        if (e.type === "tool_risk") row.risk = { verdict: d.verdict, category: d.category, reasons: d.reasons ?? [] };
        else if (e.type === "approval_requested") row.status = "awaiting-approval";
        else if (e.type === "approval_resolved") row.approval = d.outcome;
        else if (e.type === "lock_wait") row.lockWaitMs = d.ms;
        else if (e.type === "tool_execution_end") {
          row.status = d.status;
          row.ms = d.ms;
          row.result = d.resultPreview;
          row.summary = d.resultSummary;
          row.images = d.images ?? [];
          row.withheld = d.imagesWithheld;
        }
      }
    }
  }
  return view;
}

const STATUS_DOT: Record<RowStatus, string> = {
  running: "bg-status-running animate-pulse",
  "awaiting-approval": "bg-status-stopped animate-pulse",
  ok: "bg-status-idle",
  error: "bg-destructive",
  denied: "bg-status-stopped",
  cancelled: "bg-muted-foreground",
};

const SUBAGENT_LABEL: Record<string, string> = { desktop: "Desktop", browser: "Browser", shell: "Shell", supervisor: "Supervisor" };
const label = (actor: string) => SUBAGENT_LABEL[actor] ?? actor;

function formatMs(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(text?: string): string {
  const line = (text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function TraceImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    let alive = true;
    window.agentBridge.getTraceImage(path).then((url) => alive && setSrc(url)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  if (!src) return <div className="h-24 w-40 animate-pulse rounded border border-border bg-muted" />;
  return (
    <button type="button" onClick={() => setLarge((v) => !v)} className="block" title={large ? "Shrink" : "Enlarge"}>
      <img src={src} alt="Screenshot seen by the agent" className={cn("rounded border border-border", large ? "max-w-full" : "max-h-32")} />
    </button>
  );
}

function ToolRowView({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const approvalChip =
    row.approval === "approved" ? "approved by you" : row.approval === "denied" ? "denied by you" : row.approval === "timeout" ? "approval timed out" : row.approval;
  return (
    <div className="group">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-accent">
        <span className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", STATUS_DOT[row.status])} />
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[12px] font-medium text-foreground">{row.tool}</span>
          {row.intent && <span className="ml-2 text-muted-foreground">{row.intent}</span>}
        </span>
        {approvalChip && (
          <span className={cn("shrink-0 rounded border border-current px-1.5 text-[10px] uppercase tracking-wide", row.approval === "approved" ? "text-status-idle" : "text-status-stopped")}>
            {approvalChip}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{row.status === "awaiting-approval" ? "waiting for you" : formatMs(row.ms)}</span>
      </button>
      {(row.summary || row.result) && !open && (
        <div className="ml-[18px] truncate font-mono text-[11px] text-muted-foreground">
          <span className="mr-1 select-none">⎿</span>
          {row.summary || firstLine(row.result)}
        </div>
      )}
      {open && (
        <div className="ml-[18px] mt-1 space-y-2 border-l border-border pl-3 text-[11px]">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">{JSON.stringify(row.args, null, 2)}</pre>
          {row.risk && row.risk.verdict !== "allow" && (
            <div className="text-status-stopped">
              Needed approval{row.risk.category ? ` (${row.risk.category})` : ""}: {row.risk.reasons.join("; ")}
            </div>
          )}
          {row.lockWaitMs !== undefined && <div className="text-muted-foreground">Waited {formatMs(row.lockWaitMs)} for another action using the same resource.</div>}
          {row.result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{row.result}</pre>}
          {row.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {row.images.map((img) => (
                <TraceImage key={img.path} path={img.path} />
              ))}
            </div>
          )}
          {row.withheld ? <div className="text-muted-foreground">{row.withheld} screenshot(s) withheld from the model by policy.</div> : null}
        </div>
      )}
    </div>
  );
}

function NoteView({ note }: { note: NoteRow }) {
  return (
    <div className={cn("whitespace-pre-wrap px-1 py-0.5 text-[12px]", note.tone === "error" ? "text-destructive" : "italic text-muted-foreground")}>{note.text}</div>
  );
}

function GroupView({ group, defaultOpen }: { group: SubagentGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = !group.status;
  const toolCount = group.items.filter((i) => i.kind === "tool").length;
  const dot = running ? "bg-status-running animate-pulse" : group.status === "done" ? "bg-status-idle" : group.status === "blocked" ? "bg-status-stopped" : "bg-destructive";
  return (
    <div className="rounded-md border border-border">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-accent">
        {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
        <span className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", dot)} />
        <span className="min-w-0 flex-1">
          <span className="text-[12px] font-semibold text-foreground">{label(group.actor)}</span>
          <span className="ml-2 text-[12px] text-muted-foreground">{firstLine(group.brief)}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {toolCount} call{toolCount === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 border-t border-border px-2 py-1.5">
          {group.items.map((item) => (item.kind === "tool" ? <ToolRowView key={item.id} row={item} /> : <NoteView key={item.id} note={item} />))}
          {running && (
            <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> working…
            </div>
          )}
        </div>
      )}
      {group.summary && (
        <div className="border-t border-border px-2 py-1.5 text-[12px]">
          <span className="mr-1 select-none text-muted-foreground">⎿</span>
          <span className={cn("font-medium", group.status === "done" ? "text-status-idle" : group.status === "blocked" ? "text-status-stopped" : "text-destructive")}>{group.status}</span>
          <span className="ml-2 text-foreground">{group.summary}</span>
        </div>
      )}
    </div>
  );
}

const CHECK_ICON: Record<ChecklistItem["status"], string> = { pending: "○", done: "✓", failed: "✕", blocked: "⊘" };
const CHECK_COLOR: Record<ChecklistItem["status"], string> = {
  pending: "text-muted-foreground",
  done: "text-status-idle",
  failed: "text-destructive",
  blocked: "text-status-stopped",
};

export function TracePanel({ events, running, defaultOpen }: { events: TraceEvent[]; running: boolean; defaultOpen: boolean }) {
  const view = useMemo(() => buildTurnView(events), [events]);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const live = running && !view.endTs;
  const duration = view.startTs ? formatMs((view.endTs ?? Date.now()) - view.startTs) : "";
  const tokens = view.tokens >= 1000 ? `${(view.tokens / 1000).toFixed(1)}k` : String(view.tokens);

  return (
    <div className="rounded-lg border border-border bg-card text-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {live ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-status-running" />
            <span className="text-foreground">Working…</span>
          </>
        ) : (
          <span className="text-foreground">{view.status === "cancelled" ? "Stopped" : "Activity"}</span>
        )}
        <span className="ml-auto font-mono">
          {duration && `${duration} · `}
          {view.llmCalls} model call{view.llmCalls === 1 ? "" : "s"} · {tokens} tokens
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {view.checklist.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Plan</div>
              {view.checklist.map((item) => (
                <div key={item.id} className="flex gap-2 text-[12px]">
                  <span className={cn("w-3 shrink-0 text-center font-mono", CHECK_COLOR[item.status])}>{CHECK_ICON[item.status]}</span>
                  <span className={item.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}>{item.text}</span>
                </div>
              ))}
            </div>
          )}
          {view.timeline.map((item, i) =>
            item.kind === "group" ? (
              <GroupView key={item.id} group={item} defaultOpen={live || i === view.timeline.length - 1} />
            ) : item.kind === "tool" ? (
              <ToolRowView key={item.id} row={item} />
            ) : (
              <NoteView key={item.id} note={item} />
            ),
          )}
          {live && view.timeline.length === 0 && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Planning…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
