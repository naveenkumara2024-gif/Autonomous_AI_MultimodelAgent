import { contextBridge, ipcRenderer } from "electron";
import type { TraceEvent } from "../main/agent/trace";
import type { ApprovalRequest } from "../main/sandbox/approval-gate";
import type { Message, Session } from "../main/session/session-store";

type EventChannel = "session.update" | "session.status" | "session.message" | "trace.event" | "approval.request" | "approval.resolved";

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),

  listSessions: (): Promise<Session[]> => ipcRenderer.invoke("session.list"),
  listMessages: (sessionId: string): Promise<Message[]> =>
    ipcRenderer.invoke("session.messages", sessionId),
  listTrace: (sessionId: string): Promise<TraceEvent[]> => ipcRenderer.invoke("session.trace", sessionId),
  createSession: (title?: string): Promise<Session> => ipcRenderer.invoke("session.create", title),
  startSession: (sessionId: string): Promise<Session> => ipcRenderer.invoke("session.start", sessionId),
  continueSession: (
    sessionId: string,
    content: string,
  ): Promise<{ session: Session; message: Message }> =>
    ipcRenderer.invoke("session.continue", sessionId, content),
  cancelTurn: (sessionId: string): Promise<void> => ipcRenderer.invoke("session.cancel", sessionId),
  renameSession: (sessionId: string, title: string): Promise<Session> =>
    ipcRenderer.invoke("session.rename", sessionId, title),
  stopSession: (sessionId: string): Promise<Session> => ipcRenderer.invoke("session.stop", sessionId),
  deleteSession: (sessionId: string): Promise<void> => ipcRenderer.invoke("session.delete", sessionId),

  getTraceImage: (imagePath: string): Promise<string | null> => ipcRenderer.invoke("trace.image", imagePath),
  listApprovals: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke("approval.list"),
  respondApproval: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke("approval.respond", id, approved),

  onSessionEvent: (channel: EventChannel, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

export type AgentBridgeApi = typeof api;

contextBridge.exposeInMainWorld("agentBridge", api);
