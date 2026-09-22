import { contextBridge, ipcRenderer } from "electron";
import type { Message, Session } from "../main/session/session-store";

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),

  listSessions: (): Promise<Session[]> => ipcRenderer.invoke("session.list"),
  listMessages: (sessionId: string): Promise<Message[]> =>
    ipcRenderer.invoke("session.messages", sessionId),
  createSession: (title?: string): Promise<Session> => ipcRenderer.invoke("session.create", title),
  startSession: (sessionId: string): Promise<Session> => ipcRenderer.invoke("session.start", sessionId),
  continueSession: (
    sessionId: string,
    content: string,
  ): Promise<{ session: Session; message: Message }> =>
    ipcRenderer.invoke("session.continue", sessionId, content),
  renameSession: (sessionId: string, title: string): Promise<Session> =>
    ipcRenderer.invoke("session.rename", sessionId, title),
  stopSession: (sessionId: string): Promise<Session> => ipcRenderer.invoke("session.stop", sessionId),
  deleteSession: (sessionId: string): Promise<void> => ipcRenderer.invoke("session.delete", sessionId),

  onSessionEvent: (
    channel: "session.update" | "session.status",
    listener: (payload: unknown) => void,
  ): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

export type AgentBridgeApi = typeof api;

contextBridge.exposeInMainWorld("agentBridge", api);
