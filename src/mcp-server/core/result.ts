import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Plain-text success result. */
export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** Pretty-printed JSON success result (same shape the reference tools returned). */
export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

/**
 * Expected, user-facing failure (bad input, element not found, …). Unexpected
 * throws are converted by defineTool() into `"<tool> failed: <message>"`
 * instead, matching the reference server's error wording.
 */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
