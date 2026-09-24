import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import type { ApprovalRequest } from "./types";

// The human side of sandbox/approval-gate.ts. A flagged tool call stays blocked in main until
// one of these buttons is pressed; closing, Esc, or letting it time out all count as Deny.
// Deny is the focused default so the safe choice is always the easy one.

const CATEGORY_LABEL: Record<string, string> = {
  "file-delete": "Deletes data",
  "credential-entry": "Credentials",
  payment: "Payment",
  "network-egress": "Sends data out",
  "mass-modify": "System / bulk change",
};

const SUBAGENT_LABEL: Record<string, string> = { desktop: "Desktop", browser: "Browser", shell: "Shell" };

function primaryDetail(request: ApprovalRequest): { label: string; value: string } | null {
  const a = request.args;
  if (typeof a.command === "string") return { label: "Command", value: a.command };
  if (typeof a.expression === "string") return { label: "JavaScript", value: a.expression };
  if (typeof a.text === "string") return { label: "Text to type", value: a.text };
  if (Array.isArray(a.file_paths)) return { label: "Files", value: a.file_paths.join("\n") };
  return null;
}

function useCountdown(expiresAt: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ApprovalDialog({ requests }: { requests: ApprovalRequest[] }) {
  const request = requests[0];
  const denyRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown(request?.expiresAt ?? 0);

  useEffect(() => {
    setBusy(false);
    denyRef.current?.focus();
  }, [request?.id]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void respond(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!request) return null;

  async function respond(approved: boolean) {
    if (!request || busy) return;
    setBusy(true);
    await window.agentBridge.respondApproval(request.id, approved);
  }

  const detail = primaryDetail(request);
  const categories = request.risk.categories.length ? request.risk.categories : request.risk.category ? [request.risk.category] : [];
  const otherArgs = Object.fromEntries(Object.entries(request.args).filter(([k]) => !["command", "expression", "text", "file_paths"].includes(k)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-status-stopped" />
          <div className="min-w-0 flex-1">
            <h2 id="approval-title" className="text-base font-semibold text-foreground">
              Approve this action?
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {SUBAGENT_LABEL[request.subagent] ?? request.subagent} wants to run <span className="font-mono text-foreground">{request.tool}</span>
              {requests.length > 1 ? ` · 1 of ${requests.length} waiting` : ""}
            </p>
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground" title="Denied automatically when this reaches 0">
            {countdown}
          </span>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          {request.intent && <p className="text-foreground">“{request.intent}”</p>}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <span key={c} className="rounded border border-current px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-status-stopped">
                  {CATEGORY_LABEL[c] ?? c}
                </span>
              ))}
            </div>
          )}
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {request.risk.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {detail && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{detail.label}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-3 font-mono text-[12px] text-foreground">
                {detail.value}
              </pre>
            </div>
          )}
          {Object.keys(otherArgs).length > 0 && (
            <details className="text-[12px] text-muted-foreground">
              <summary className="cursor-pointer select-none">All arguments</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">{JSON.stringify(otherArgs, null, 2)}</pre>
            </details>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button ref={denyRef} type="button" variant="secondary" disabled={busy} onClick={() => void respond(false)}>
            Deny
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void respond(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
