import { contextBridge, ipcRenderer } from "electron";

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
};

export type AgentBridgeApi = typeof api;

contextBridge.exposeInMainWorld("agentBridge", api);
