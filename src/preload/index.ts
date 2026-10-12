import { contextBridge, ipcRenderer } from "electron";
import type { TraceEvent } from "../main/agent/trace";
import type { ApprovalRequest } from "../main/sandbox/approval-gate";
import type { Message, Session } from "../main/session/session-store";


type EventChannel = "session.update" | "session.status" | "session.message" | "trace.event" | "approval.request" | "approval.resolved" | "voice.state" | "voice.capture" | "voice.focus-session" | "automation.focus";

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

  // Voice trigger. setVoiceTarget is called by the main window; the rest by the overlay window
  // (main ignores them from any other sender).
  setVoiceTarget: (sessionId: string | null): Promise<void> => ipcRenderer.invoke("voice.setTarget", sessionId),
  voiceToggle: (): Promise<void> => ipcRenderer.invoke("voice.toggle"),
  voiceCancel: (): Promise<void> => ipcRenderer.invoke("voice.cancel"),
  voiceSubmit: (wav: Uint8Array): Promise<void> => ipcRenderer.invoke("voice.submit", wav),
  voiceCaptureError: (reason: string): Promise<void> => ipcRenderer.invoke("voice.captureError", reason),

  // Automation overlay (called from the overlay window; main ignores them from any other sender).
  getAutomationFocus: (): Promise<{ sessionId: string; turnId: string } | null> => ipcRenderer.invoke("automation.focus.get"),
  hideAutomationOverlay: (): Promise<boolean> => ipcRenderer.invoke("automation.hide"),
  setAutomationCollapsed: (collapsed: boolean): Promise<void> => ipcRenderer.invoke("automation.setCollapsed", collapsed),
  openMainWindow: (): Promise<void> => ipcRenderer.invoke("automation.openMainWindow"),

  onSessionEvent: (channel: EventChannel, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

export type AgentBridgeApi = typeof api;

contextBridge.exposeInMainWorld("agentBridge", api);
