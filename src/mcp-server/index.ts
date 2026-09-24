import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "./core/async";
import { createToolRegistrar } from "./core/define-tool";
import { DATA_DIR, migrateLegacyData } from "./core/paths";
import { registerAppTools } from "./tools/apps";
import { registerBrowserDomTools } from "./tools/browser-dom";
import { registerBrowserPageTools } from "./tools/browser-page";
import { registerBrowserTabTools } from "./tools/browser-tabs";
import { registerElementTools } from "./tools/element";
import { registerKeyboardTools } from "./tools/keyboard";
import { registerMiscTools } from "./tools/misc";
import { registerMouseTools } from "./tools/mouse";
import { registerScreenTools } from "./tools/screen";
import { registerShellTools } from "./tools/shell";
import { registerSystemTools } from "./tools/system";

// mcp-desktop: Windows desktop + Chrome automation and PowerShell execution over MCP (stdio).
// Ported from the Mcpgui reference project — see prompts/stage-3-mcp-automation-agent.md for
// the tool-parity table. Runs standalone (VS Code / Claude Code mcp.json) or as a child of the
// Electron app's mcp-client.ts. stdout is JSON-RPC only; every log line goes to stderr.

export const SERVER_NAME = "mcp-desktop";
export const SERVER_VERSION = "2.0.0";

export function createServer(): { server: McpServer; toolNames: string[] } {
  // Declares MCP's logging capability so clients that render notifications/message show tool
  // activity, in addition to the stderr lines every stdio client captures regardless.
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { logging: {} } });
  const { defineTool, names } = createToolRegistrar(server);

  registerAppTools(defineTool);
  registerMouseTools(defineTool);
  registerKeyboardTools(defineTool);
  registerScreenTools(defineTool);
  registerElementTools(defineTool);
  registerSystemTools(defineTool);
  registerMiscTools(defineTool);
  registerBrowserTabTools(defineTool);
  registerBrowserDomTools(defineTool);
  registerBrowserPageTools(defineTool);
  registerShellTools(defineTool);

  return { server, toolNames: names };
}

async function main(): Promise<void> {
  const { migrated } = await migrateLegacyData().catch((error) => {
    console.error(`[mcp-desktop] legacy data migration skipped: ${errorMessage(error)}`);
    return { migrated: false };
  });
  const { server, toolNames } = createServer();
  await server.connect(new StdioServerTransport());
  console.error(
    `[mcp-desktop] v${SERVER_VERSION} running on stdio — ${toolNames.length} tools, data dir ${DATA_DIR}${migrated ? " (copied click history from ~/.mcpgui)" : ""}`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-desktop] fatal:", error);
    process.exit(1);
  });
}
