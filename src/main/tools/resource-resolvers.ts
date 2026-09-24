import path from "node:path";

/**
 * Computes a tool call's `resources` from its literal args (AGENTS.md section 7). This — not
 * the tool's name, kind, or which subagent issued it — is what the lock manager serializes on.
 * Adding a tool means adding a line here; nothing in dispatch changes.
 */

export const NATIVE_INPUT = "native-input";
export const SHELL = "shell";
export const APP_MEMORY = "app-memory";

const NATIVE_INPUT_TOOLS = new Set(["click", "scroll", "drag", "move_mouse", "type_text", "key_press"]);
const APP_MEMORY_TOOLS = new Set(["init_app", "clear_click_history", "get_click_history", "get_all_visited_apps"]);
const SYSTEM_AUDIO_TOOLS = new Set(["get_volume", "set_volume"]);
const SYSTEM_DISPLAY_TOOLS = new Set(["get_brightness", "set_brightness"]);

/** Tab-scoped browser tools; the MCP server tracks the "active" tab, so unspecified = active. */
function browserContext(args: Record<string, unknown>): string {
  const tabId = typeof args.tab_id === "string" && args.tab_id ? args.tab_id : "active";
  return `browser-context:${tabId}`;
}

function fileKey(p: string): string {
  return `file:${path.resolve(p).toLowerCase()}`;
}

export function resolveResources(tool: string, args: Record<string, unknown>): string[] {
  if (NATIVE_INPUT_TOOLS.has(tool)) return [NATIVE_INPUT];
  if (APP_MEMORY_TOOLS.has(tool)) return [APP_MEMORY];
  if (SYSTEM_AUDIO_TOOLS.has(tool)) return ["system:audio"];
  if (SYSTEM_DISPLAY_TOOLS.has(tool)) return ["system:brightness"];
  // An arbitrary command's footprint can't be known from its text, so shell commands serialize
  // with each other (and only each other).
  if (tool === "run_powershell") return [SHELL];

  if (tool === "screenshot") return typeof args.output_path === "string" ? [fileKey(args.output_path)] : [];

  if (tool.startsWith("browser_")) {
    // Connect/list/new-tab only touch the browser-level connection, not a tab's DOM.
    if (tool === "browser_connect" || tool === "browser_list_tabs") return [];
    if (tool === "browser_new_tab") return ["browser-context:active"];
    if (tool === "browser_set_file_input") {
      const files = Array.isArray(args.file_paths) ? args.file_paths.filter((f): f is string => typeof f === "string") : [];
      return [browserContext(args), ...files.map(fileKey)];
    }
    return [browserContext(args)];
  }

  // Read-only observation (screenshot_for_display, find_element, get_displays, get_mouse_position,
  // wait, echo) holds nothing.
  return [];
}
