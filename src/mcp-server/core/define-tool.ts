import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type * as z from "zod";
import { errorMessage } from "./async";

// --- Tool-call logging ---
//
// stdout is reserved for JSON-RPC framing, so logs go to stderr — every stdio MCP client
// (VS Code, Claude Code, and this app's own mcp-client.ts) captures a server's stderr. We also
// best-effort send a proper `notifications/message` for clients that render MCP's logging
// capability; if none is connected yet, that fails silently and the stderr line stands.

type LogPhase = "call" | "result" | "error";

function truncateForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…(${value.length} chars)` : value;
  if (Array.isArray(value)) return depth > 3 ? `[array(${value.length})]` : value.map((v) => truncateForLog(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 3) return "[object]";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateForLog(v, depth + 1)]));
  }
  return value;
}

// Result content can carry a full base64 screenshot; logs should note that it happened, not
// reproduce it.
function summarizeToolResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content?.[0];
  let preview: string | undefined;
  if (first?.type === "text") {
    preview = first.text.length > 300 ? `${first.text.slice(0, 300)}…` : first.text;
  } else if (first?.type === "image") {
    preview = `[image ${first.mimeType}, ${first.data.length} base64 chars]`;
  }
  return { isError: Boolean(result.isError), contentItems: result.content?.length ?? 0, preview };
}

export interface ToolContext {
  /** Aborted when the client cancels the request (e.g. the user stopped the turn). */
  signal: AbortSignal;
}

export type ToolArgs<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export type DefineTool = <S extends z.ZodRawShape>(
  name: string,
  config: { description: string; inputSchema: S },
  handler: (args: ToolArgs<S>, ctx: ToolContext) => Promise<CallToolResult> | CallToolResult,
) => void;

let callSeq = 0;

/**
 * Returns the one registration helper every tool module uses. Beyond plain
 * `server.registerTool`, it adds per-call logging (call/result/error with timing and a call id
 * to correlate the lines), and converts any unexpected throw into a normal `isError` result
 * worded `"<tool> failed: <message>"` — the reference server repeated that try/catch in every
 * one of its 38 tools; here it lives once.
 */
export function createToolRegistrar(server: McpServer): { defineTool: DefineTool; names: string[] } {
  const names: string[] = [];

  const log = (tool: string, callId: number, phase: LogPhase, details: Record<string, unknown>): void => {
    const level = phase === "error" ? "error" : phase === "call" ? "debug" : "info";
    console.error(`[${new Date().toISOString()}] [mcp-desktop:${tool}#${callId}] ${phase.toUpperCase()} ${JSON.stringify(details)}`);
    server.server
      .sendLoggingMessage({ level, logger: "mcp-desktop", data: { tool, callId, phase, ...details } })
      .catch(() => {
        // No connected client yet, or it doesn't support logging — stderr above already has it.
      });
  };

  const defineTool: DefineTool = (name, config, handler) => {
    names.push(name);
    const wrapped = async (args: unknown, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      const callId = ++callSeq;
      const start = Date.now();
      log(name, callId, "call", truncateForLog(args) as Record<string, unknown>);
      try {
        const result = await handler(args as never, { signal: extra.signal });
        log(name, callId, result.isError ? "error" : "result", { ms: Date.now() - start, ...summarizeToolResult(result) });
        return result;
      } catch (error) {
        const message = errorMessage(error);
        log(name, callId, "error", { ms: Date.now() - start, thrown: message });
        return { content: [{ type: "text", text: `${name} failed: ${message}` }], isError: true };
      }
    };
    server.registerTool(
      name,
      { description: config.description, inputSchema: config.inputSchema } as Parameters<typeof server.registerTool>[1],
      wrapped as Parameters<typeof server.registerTool>[2],
    );
  };

  return { defineTool, names };
}
