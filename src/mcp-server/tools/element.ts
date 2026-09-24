import * as z from "zod";
import type { DefineTool } from "../core/define-tool";
import { fail, json } from "../core/result";
import { uiAutomationWorker, type UiElement } from "../powershell/workers";
import { COORDINATE_MODES, getDisplays, resolvePoint } from "../win32/displays";

export function registerElementTools(defineTool: DefineTool): void {
  defineTool(
    "find_element",
    {
      description:
        'Desktop automation tool: find a UI element in a DESKTOP application via the Windows Accessibility API (UI Automation) instead of vision. Works against any native window (for elements inside the automation Chrome tab, use browser_find). Prefer this over a screenshot whenever you know the element\'s name, AutomationId, or control type — it returns exact bounding coordinates from the OS. Searches the window matching window_title (partial, case-insensitive), or the foreground window if omitted. On a match, `center` is an absolute virtual-screen coordinate usable directly with click/move_mouse/scroll/drag via coordinate_type: "screen". Pass focused: true instead to get the element that currently has keyboard focus. Use vision (screenshot_for_display) only when this returns found: false.',
      inputSchema: {
        name: z.string().optional().describe("Match the element's accessible Name (exact)."),
        automation_id: z.string().optional().describe("Match the element's AutomationId (exact)."),
        control_type: z
          .string()
          .optional()
          .describe('Restrict to a UI Automation ControlType, e.g. "Button", "Edit", "MenuItem", "CheckBox", "ComboBox", "TreeItem", "Document".'),
        window_title: z
          .string()
          .optional()
          .describe("Only search within the top-level window whose title contains this text (case-insensitive). Defaults to the foreground window."),
        focused: z.boolean().default(false).describe("Return the element with keyboard focus instead of searching. Other criteria are ignored."),
        at_point: z
          .object({
            x: z.number(),
            y: z.number(),
            coordinate_type: z.enum(COORDINATE_MODES).default("screen"),
            display_index: z.number().default(0),
          })
          .optional()
          .describe("Return the element under this point (same coordinate rules as click) instead of searching. Other criteria are ignored."),
        timeout_ms: z.number().default(3000).describe("Max time to wait for the element to appear. Default: 3000"),
      },
    },
    async ({ name, automation_id, control_type, window_title, focused, at_point, timeout_ms }) => {
      if (focused) {
        return json(await uiAutomationWorker.request<UiElement>({ action: "focused_element" }, 5000));
      }
      if (at_point) {
        const point = resolvePoint(at_point.coordinate_type, at_point.x, at_point.y, at_point.display_index, getDisplays());
        if ("error" in point) return fail(point.error);
        const element = await uiAutomationWorker.request<UiElement>({ action: "element_at_point", x: point.x, y: point.y }, 5000);
        return json({ ...element, point: { x: point.x, y: point.y } });
      }
      if (!name && !automation_id && !control_type) return fail("Provide at least one of name, automation_id, or control_type (or focused: true).");
      const result = await uiAutomationWorker.request<UiElement>(
        { action: "find_element", name, automation_id, control_type, window_title, timeout_ms },
        timeout_ms + 2000,
      );
      return json(result);
    },
  );
}
