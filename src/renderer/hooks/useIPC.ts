import { useEffect } from "react";
import type { Session } from "../types";

/** Thin wrapper over window.agentBridge so components don't touch it directly. */
export function useAgentBridge() {
  return window.agentBridge;
}

interface SessionUpdatePayload extends Partial<Session> {
  id: string;
  deleted?: boolean;
}

interface SessionStatusPayload {
  id: string;
  status: Session["status"];
}

export function useSessionUpdateEvent(onUpdate: (payload: SessionUpdatePayload) => void): void {
  useEffect(() => {
    if (!window.agentBridge) return;
    return window.agentBridge.onSessionEvent("session.update", (payload) =>
      onUpdate(payload as SessionUpdatePayload),
    );
  }, [onUpdate]);
}

export function useSessionStatusEvent(onStatus: (payload: SessionStatusPayload) => void): void {
  useEffect(() => {
    if (!window.agentBridge) return;
    return window.agentBridge.onSessionEvent("session.status", (payload) =>
      onStatus(payload as SessionStatusPayload),
    );
  }, [onStatus]);
}
