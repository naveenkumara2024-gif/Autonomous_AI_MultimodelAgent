import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CandidateImage, RedactionRecord } from "../perception/redactor";
import type { McpToolInfo } from "./mcp-client";

/**
 * Translates between MCP and the model's OpenAI-style function calling:
 *   - MCP tool → function schema, with a required `intent` parameter injected (a one-line,
 *     user-facing statement of what this specific call is for — like Claude Code's command
 *     `description`). It becomes the trace row title and the call's `restatedGoal`, and is
 *     stripped before the call reaches MCP.
 *   - MCP CallToolResult → model-ready text + images.
 */

export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const INTENT_PARAM = "intent";

const INTENT_SCHEMA = {
  type: "string",
  description:
    "One short sentence, in plain language, saying what this specific call is for (e.g. \"Open the File menu\", \"Check the Downloads folder size\"). Shown to the user in the activity trace.",
};

export function toFunctionTool(tool: McpToolInfo): FunctionTool {
  const { $schema: _ignored, ...schema } = tool.inputSchema as { $schema?: string; properties?: Record<string, unknown>; required?: string[] };
  const properties = { [INTENT_PARAM]: INTENT_SCHEMA, ...(schema.properties ?? {}) };
  const required = [INTENT_PARAM, ...(schema.required ?? []).filter((r) => r !== INTENT_PARAM)];
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { ...schema, type: "object", properties, required },
    },
  };
}

export function splitIntent(args: Record<string, unknown>): { intent: string; args: Record<string, unknown> } {
  const { [INTENT_PARAM]: intent, ...rest } = args;
  return { intent: typeof intent === "string" && intent.trim() ? intent.trim() : "", args: rest };
}

const MAX_RESULT_TEXT = 12_000;

export interface AdaptedResult {
  text: string;
  images: CandidateImage[];
  isError: boolean;
}

export function adaptResult(result: CallToolResult): AdaptedResult {
  const texts: string[] = [];
  const images: CandidateImage[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "image") {
      const redaction = (block._meta as { redaction?: RedactionRecord } | undefined)?.redaction;
      images.push({ mimeType: block.mimeType, data: block.data, redaction });
    } else {
      texts.push(`[${block.type} content omitted]`);
    }
  }
  let text = texts.join("\n");
  if (text.length > MAX_RESULT_TEXT) {
    text = `${text.slice(0, MAX_RESULT_TEXT)}\n…[result truncated: ${text.length - MAX_RESULT_TEXT} more characters]`;
  }
  return { text, images, isError: Boolean(result.isError) };
}
