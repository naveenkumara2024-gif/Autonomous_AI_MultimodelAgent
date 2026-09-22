import { ipcMain, type IpcMainInvokeEvent } from "electron";

/**
 * Shared IPC registration helper. Each domain module (session, agent,
 * sandbox, ...) registers its own handlers through this instead of a
 * standalone ipc/ folder — see AGENTS.md section 5.
 */
export function registerHandler<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
}
