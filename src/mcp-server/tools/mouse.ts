import { ptr } from "bun:ffi";
import * as z from "zod";
import {
  findCachedLocation,
  getCurrentApp,
  markClickHistoryUsed,
  resolveCachedLocation,
  saveCurrentClickHistory,
  upsertClickHistory,
} from "../app-memory/app-store";
import { sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { fail, json, text } from "../core/result";
import { invalidateCaptureCache } from "../win32/capture";
import { COORDINATE_MODES, displayContaining, getDisplays, resolvePoint, type ResolvedPoint } from "../win32/displays";
import { getUser32 } from "../win32/ffi";
import {
  makeMouseInput,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_WHEEL,
  resolveModifiers,
  sendInputs,
  WHEEL_DELTA,
  withModifiers,
} from "../win32/input";

const coordinateType = (defaultMode: (typeof COORDINATE_MODES)[number]) =>
  z
    .enum(COORDINATE_MODES)
    .default(defaultMode)
    .describe(
      'Coordinate interpretation. "absolute" = display-local logical pixels. "normalized" = 0-1000 relative to the display (use this for points read off a screenshot). "screen" = absolute virtual-screen pixels (e.g. find_element\'s `center`), ignores display_index. "auto" uses absolute, but converts from normalized if values are out of bounds.',
    );

const displayIndex = z.number().default(0).describe("Display index (0 = main display). See get_displays. Ignored for coordinate_type \"screen\".");

export function registerMouseTools(defineTool: DefineTool): void {
  defineTool(
    "click",
    {
      description:
        'Desktop automation tool: performs a REAL OS-level mouse click via Windows SendInput, at the pixel/coordinate level — works against any on-screen application, with no notion of DOM elements. For clicking inside a web page in the automation Chrome, prefer browser_click (CSS-selector based). Supports single, double, right, and triple click. PERSISTING LOCATIONS: pass `label` with x/y to name this element for later reuse; pass `label` alone (omit x/y) to click the cached location for that label on the current app without a new screenshot. Prefer a cached label or find_element over taking a screenshot — use vision only when neither can locate the target.',
      inputSchema: {
        coordinate_type: coordinateType("auto"),
        x: z.number().optional().describe("X coordinate (interpretation depends on coordinate_type). Omit when clicking a cached label."),
        y: z.number().optional().describe("Y coordinate (interpretation depends on coordinate_type). Omit when clicking a cached label."),
        display_index: displayIndex,
        click_type: z.enum(["single", "double", "right", "triple"]).default("single").describe("Type of click to perform."),
        modifiers: z.array(z.string()).default([]).describe("Modifier keys to hold during the click: ctrl, shift, alt, win."),
        label: z
          .string()
          .optional()
          .describe('Stable name for this UI element (e.g. "Save button"). With x/y: caches this location under the label for the current app (requires init_app). Without x/y: reuses the cached location for this label.'),
        verified: z
          .boolean()
          .default(false)
          .describe("Set true when you have visually confirmed (via a screenshot) that this exact label/location is correct. Bumps its reliability count."),
      },
    },
    async ({ coordinate_type, x, y, display_index, click_type, modifiers, label, verified }) => {
      const user32 = getUser32();
      const displays = getDisplays();
      const app = getCurrentApp();

      let point: ResolvedPoint;
      let isCacheHit = false;

      if (x === undefined || y === undefined) {
        if (!label) return fail("Provide x and y, or a label to reuse a cached location.");
        if (!app) return fail(`No app initialized; cannot resolve label "${label}". Call init_app first.`);
        const cached = findCachedLocation(app.clickHistory, label);
        if (!cached) {
          return fail(
            `No cached location for label "${label}" on "${app.appName}". Locate it (find_element, or a screenshot) and click with x/y and label to cache it.`,
          );
        }
        point = resolveCachedLocation(cached, displays);
        isCacheHit = true;
      } else {
        const resolved = resolvePoint(coordinate_type, x, y, display_index, displays);
        if ("error" in resolved) return fail(resolved.error);
        point = resolved;
      }

      const heldVks = resolveModifiers(modifiers);
      if (!Array.isArray(heldVks)) return fail(heldVks.error);

      if (!user32.SetCursorPos(point.x, point.y)) return fail(`Failed to move cursor to (${point.x}, ${point.y}).`);

      const [downFlag, upFlag] =
        click_type === "right" ? [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP] : [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP];
      const clickCount = click_type === "double" ? 2 : click_type === "triple" ? 3 : 1;
      const clicks: Uint8Array[] = [];
      for (let i = 0; i < clickCount; i++) clicks.push(makeMouseInput(downFlag), makeMouseInput(upFlag));

      sendInputs(user32, withModifiers(heldVks, clicks));
      invalidateCaptureCache();

      if (app && label) {
        if (isCacheHit) {
          markClickHistoryUsed(app.clickHistory, label, verified);
        } else {
          const display = displays[point.displayIndex];
          if (display) {
            upsertClickHistory(app.clickHistory, { label, display, globalX: point.x, globalY: point.y, clickType: click_type, verified });
          }
        }
        await saveCurrentClickHistory();
      }

      const labelNote = label ? ` (label: "${label}"${isCacheHit ? ", cached" : ""})` : "";
      return text(`Performed ${click_type} click at (${point.x}, ${point.y}) on display ${point.displayIndex}${labelNote}.`);
    },
  );

  defineTool(
    "scroll",
    {
      description:
        "Desktop automation tool: performs a REAL OS-level mouse-wheel scroll via Windows SendInput at the given position — works against any on-screen application, not just a browser page.",
      inputSchema: {
        coordinate_type: coordinateType("auto"),
        x: z.number().describe("X coordinate to scroll at (interpretation depends on coordinate_type)."),
        y: z.number().describe("Y coordinate to scroll at (interpretation depends on coordinate_type)."),
        display_index: displayIndex,
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction."),
        amount: z.number().default(3).describe("Scroll amount (number of wheel notches). Default: 3"),
      },
    },
    async ({ coordinate_type, x, y, display_index, direction, amount }) => {
      const user32 = getUser32();
      const resolved = resolvePoint(coordinate_type, x, y, display_index, getDisplays());
      if ("error" in resolved) return fail(resolved.error);

      if (!user32.SetCursorPos(resolved.x, resolved.y)) return fail(`Failed to move cursor to (${resolved.x}, ${resolved.y}).`);

      const isHorizontal = direction === "left" || direction === "right";
      const sign = direction === "down" || direction === "left" ? -1 : 1;
      sendInputs(user32, [makeMouseInput(isHorizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, sign * amount * WHEEL_DELTA)]);
      invalidateCaptureCache();

      return text(`Scrolled ${direction} by ${amount} at (${resolved.x}, ${resolved.y}) on display ${resolved.displayIndex}.`);
    },
  );

  defineTool(
    "drag",
    {
      description:
        "Desktop automation tool: performs a REAL OS-level click-and-drag via Windows SendInput, moving the physical cursor through intermediate points — works against any on-screen application. By default coordinates are normalized (0-1000) relative to the target display.",
      inputSchema: {
        coordinate_type: coordinateType("normalized"),
        from_x: z.number().describe("Starting X coordinate (normalized 0-1000 by default)."),
        from_y: z.number().describe("Starting Y coordinate (normalized 0-1000 by default)."),
        to_x: z.number().describe("Ending X coordinate (normalized 0-1000 by default)."),
        to_y: z.number().describe("Ending Y coordinate (normalized 0-1000 by default)."),
        display_index: displayIndex,
      },
    },
    async ({ coordinate_type, from_x, from_y, to_x, to_y, display_index }) => {
      const user32 = getUser32();
      const displays = getDisplays();
      const from = resolvePoint(coordinate_type, from_x, from_y, display_index, displays);
      if ("error" in from) return fail(from.error);
      const to = resolvePoint(coordinate_type, to_x, to_y, display_index, displays);
      if ("error" in to) return fail(to.error);

      if (!user32.SetCursorPos(from.x, from.y)) return fail(`Failed to move cursor to (${from.x}, ${from.y}).`);
      sendInputs(user32, [makeMouseInput(MOUSEEVENTF_LEFTDOWN)]);

      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const stepX = Math.round(from.x + (to.x - from.x) * t);
        const stepY = Math.round(from.y + (to.y - from.y) * t);
        if (!user32.SetCursorPos(stepX, stepY)) {
          // Release the held button before bailing so the OS isn't left mid-drag.
          sendInputs(user32, [makeMouseInput(MOUSEEVENTF_LEFTUP)]);
          invalidateCaptureCache();
          return fail(`Drag aborted: failed to move cursor to (${stepX}, ${stepY}) mid-drag.`);
        }
        await sleep(15);
      }

      sendInputs(user32, [makeMouseInput(MOUSEEVENTF_LEFTUP)]);
      invalidateCaptureCache();
      return text(`Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) on display ${display_index}.`);
    },
  );

  defineTool(
    "move_mouse",
    {
      description:
        "Desktop automation tool: moves the REAL OS-level mouse cursor to a position without clicking (e.g. to reveal a hover menu or tooltip). Works with any on-screen application.",
      inputSchema: {
        coordinate_type: coordinateType("auto"),
        x: z.number().describe("X coordinate (interpretation depends on coordinate_type)."),
        y: z.number().describe("Y coordinate (interpretation depends on coordinate_type)."),
        display_index: displayIndex,
      },
    },
    async ({ coordinate_type, x, y, display_index }) => {
      const resolved = resolvePoint(coordinate_type, x, y, display_index, getDisplays());
      if ("error" in resolved) return fail(resolved.error);
      if (!getUser32().SetCursorPos(resolved.x, resolved.y)) return fail(`Failed to move cursor to (${resolved.x}, ${resolved.y}).`);
      return text(`Moved cursor to (${resolved.x}, ${resolved.y}) on display ${resolved.displayIndex}.`);
    },
  );

  defineTool(
    "get_mouse_position",
    {
      description: "Desktop automation tool (OS-level, not browser-scoped): get the current REAL mouse cursor position, including which display it is on.",
      inputSchema: {},
    },
    async () => {
      const pointBuf = new Uint8Array(8);
      if (!getUser32().GetCursorPos(ptr(pointBuf))) return fail("GetCursorPos failed.");
      const dv = new DataView(pointBuf.buffer);
      const x = dv.getInt32(0, true);
      const y = dv.getInt32(4, true);
      const display = displayContaining(getDisplays(), x, y);
      return json({
        x,
        y,
        display_index: display?.index ?? null,
        local_x: display ? x - display.left : null,
        local_y: display ? y - display.top : null,
      });
    },
  );
}
