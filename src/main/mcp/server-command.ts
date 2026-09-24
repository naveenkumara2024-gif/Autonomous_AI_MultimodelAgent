import path from "node:path";
import type { McpServerCommand } from "./mcp-client";

/**
 * How to launch the mcp-desktop server. Dev: Bun runs the TypeScript source directly (bun:ffi
 * needs Bun). Packaged: `bun run build:mcp` compiled it into a standalone mcp-desktop.exe that
 * electron-builder ships in resources/, so end users don't need Bun installed.
 */
export function resolveMcpServerCommand(options: { isPackaged: boolean; appRoot: string; resourcesPath: string }): McpServerCommand {
  if (options.isPackaged) {
    return { command: path.join(options.resourcesPath, "mcp-desktop.exe"), args: [] };
  }
  return { command: "bun", args: ["run", path.join(options.appRoot, "src", "mcp-server", "index.ts")], cwd: options.appRoot };
}
