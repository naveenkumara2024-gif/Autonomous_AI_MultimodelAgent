import { desktopSystemPrompt } from "../prompts/desktop";
import type { SubagentDef } from "../subagent-registry";

const DESKTOP_TOOLS = new Set([
  "launch_app", "get_all_visited_apps", "init_app", "get_click_history", "clear_click_history",
  "click", "scroll", "drag", "move_mouse", "get_mouse_position", "type_text", "key_press",
  "get_displays", "screenshot", "screenshot_for_display", "find_element",
  "get_volume", "set_volume", "get_brightness", "set_brightness", "wait",
]);

export const desktopSubagent: SubagentDef = {
  name: "desktop",
  description:
    "Operates native Windows applications with real mouse/keyboard input, UI Automation element lookup, and screenshots. Opens or switches to apps (instantly, by name), clicks, types, uses menus and dialogs, arranges windows, adjusts volume/brightness.",
  selectTools: (name) => DESKTOP_TOOLS.has(name),
  systemPrompt: desktopSystemPrompt,
};
