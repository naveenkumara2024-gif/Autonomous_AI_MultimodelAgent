import { useEffect, useState } from "react";
import type { ApprovalRequest, TraceEvent } from "../types";

/** A session's full trace: loaded from SQLite, then kept live from "trace.event". */
export function useTrace(sessionId: string | null): TraceEvent[] {
  const [events, setEvents] = useState<TraceEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    if (!sessionId || !window.agentBridge) return;
    let cancelled = false;
    const seen = new Set<string>();

    const unsubscribe = window.agentBridge.onSessionEvent("trace.event", (payload) => {
      const event = payload as TraceEvent;
      if (event.sessionId !== sessionId || seen.has(event.id)) return;
      seen.add(event.id);
      setEvents((prev) => [...prev, event]);
    });

    window.agentBridge
      .listTrace(sessionId)
      .then((stored) => {
        if (cancelled) return;
        // Merge: events that streamed in while the history was loading are kept.
        setEvents((live) => {
          const merged = new Map<string, TraceEvent>();
          for (const e of [...stored, ...live]) merged.set(e.id, e);
          for (const id of merged.keys()) seen.add(id);
          return [...merged.values()].sort((a, b) => a.seq - b.seq);
        });
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return events;
}

/** Approval requests waiting on the user, across all sessions. */
export function useApprovals(): ApprovalRequest[] {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    if (!window.agentBridge) return;
    window.agentBridge.listApprovals().then(setRequests).catch(console.error);
    const offRequest = window.agentBridge.onSessionEvent("approval.request", (payload) => {
      const request = payload as ApprovalRequest;
      setRequests((prev) => (prev.some((r) => r.id === request.id) ? prev : [...prev, request]));
    });
    const offResolved = window.agentBridge.onSessionEvent("approval.resolved", (payload) => {
      const { id } = payload as { id: string };
      setRequests((prev) => prev.filter((r) => r.id !== id));
    });
    return () => {
      offRequest();
      offResolved();
    };
  }, []);

  return requests;
}
