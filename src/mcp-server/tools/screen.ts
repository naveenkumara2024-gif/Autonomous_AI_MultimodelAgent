import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";
import { errorMessage } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { SCREENSHOTS_DIR } from "../core/paths";
import { fail, json, text } from "../core/result";
import { redactionWorker } from "../powershell/workers";
import { captureRegion } from "../win32/capture";
import {
  getDisplays,
  invalidDisplayMessage,
  SM_CXVIRTUALSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
} from "../win32/displays";
import { getUser32 } from "../win32/ffi";
import { encodeBmp, encodePng, type Rect } from "../win32/png";

const DEFAULT_MAX_EDGE = 1600;
const REDACTION_TIMEOUT_MS = 1500;

const regionSchema = z
  .object({
    x: z.number().describe("X coordinate of the region (global screen coordinates)."),
    y: z.number().describe("Y coordinate of the region (global screen coordinates)."),
    width: z.number().describe("Width of the region."),
    height: z.number().describe("Height of the region."),
  })
  .describe("Capture a specific region instead of a full display.");

type Region = { x: number; y: number; width: number; height: number };

/** Region from an explicit rect, a display index, or (neither) the whole virtual screen. */
function resolveRegion(region: Region | undefined, displayIndex: number | undefined): Region | { error: string } {
  if (region) return region;
  if (displayIndex !== undefined) {
    const displays = getDisplays();
    const display = displays[displayIndex];
    if (!display) return { error: invalidDisplayMessage(displayIndex, displays) };
    return { x: display.left, y: display.top, width: display.width, height: display.height };
  }
  const user32 = getUser32();
  return {
    x: user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

export interface RedactionRecord {
  method: "uia-password-fields";
  scope: "foreground-window";
  masked: number;
  complete: boolean;
  error?: string;
}

/**
 * Password-field rects (UI Automation IsPassword) in the foreground window, clipped and made
 * region-local, to be painted black before the image leaves this process. This is the capture
 * half of the screen-content firewall; the app's perception/redactor.ts refuses to forward any
 * image that doesn't carry this record. Deliberately narrow (password fields only) — see
 * prompts/stage-3-mcp-automation-agent.md decision 8.
 */
async function passwordMasks(region: Region): Promise<{ masks: Rect[]; record: RedactionRecord }> {
  try {
    const result = await redactionWorker.request<{ ok: boolean; rects?: Rect[]; error?: string }>({ action: "password_rects" }, REDACTION_TIMEOUT_MS);
    const masks = (result.rects ?? [])
      .map((r) => {
        const x0 = Math.max(r.x, region.x);
        const y0 = Math.max(r.y, region.y);
        const x1 = Math.min(r.x + r.width, region.x + region.width);
        const y1 = Math.min(r.y + r.height, region.y + region.height);
        return { x: x0 - region.x, y: y0 - region.y, width: x1 - x0, height: y1 - y0 };
      })
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      masks,
      record: { method: "uia-password-fields", scope: "foreground-window", masked: masks.length, complete: result.ok !== false, ...(result.error ? { error: result.error } : {}) },
    };
  } catch (error) {
    return { masks: [], record: { method: "uia-password-fields", scope: "foreground-window", masked: 0, complete: false, error: errorMessage(error) } };
  }
}

export function registerScreenTools(defineTool: DefineTool): void {
  defineTool(
    "get_displays",
    {
      description:
        "Desktop automation tool (OS-level): get information about all connected displays — index, name, resolution, position, and scale factor. Use this to understand the multi-monitor setup before GUI operations. Cached for 5s; pass refresh: true after a display is connected/disconnected.",
      inputSchema: {
        refresh: z.boolean().default(false).describe("Bypass the cache and re-query the OS for the current display layout."),
      },
    },
    async ({ refresh }) => json(getDisplays(refresh)),
  );

  defineTool(
    "screenshot",
    {
      description:
        "Desktop automation tool: captures the REAL OS screen (via GDI BitBlt) — the entire virtual screen, one display, or a region — and SAVES it to a local file (PNG by default; a .bmp output_path keeps the original BMP format). Does not return the image to you; use screenshot_for_display to actually look at the screen. For a web page's rendered content use browser_screenshot. Captures of the same region are cached (and auto-invalidated after click/type_text/key_press/scroll/drag); pass force_refresh: true to bypass that.",
      inputSchema: {
        output_path: z.string().optional().describe("Path to save the screenshot. Defaults to the app's screenshots folder."),
        display_index: z.number().optional().describe("Display index to capture. If omitted (and no region given), captures all displays."),
        region: regionSchema.optional(),
        force_refresh: z.boolean().default(false).describe("Bypass the capture cache and capture fresh."),
      },
    },
    async ({ output_path, display_index, region, force_refresh }) => {
      const target = resolveRegion(region, display_index);
      if ("error" in target) return fail(target.error);

      const raw = await captureRegion(target.x, target.y, target.width, target.height, force_refresh);
      const outPath = resolve(output_path ?? join(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`));
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, outPath.toLowerCase().endsWith(".bmp") ? encodeBmp(raw) : encodePng(raw).data);

      return text(`Screenshot (${target.width}x${target.height}) saved to ${outPath}.`);
    },
  );

  defineTool(
    "screenshot_for_display",
    {
      description:
        'Desktop automation tool: captures the REAL OS screen and returns it to you as an image so you can see it. Shows whatever is actually on screen (any application). Password fields are blacked out before the image leaves the machine. The image may be downscaled; to act on something you see in it, use click with coordinate_type "normalized" (x = px / image_width * 1000, y = py / image_height * 1000, same display_index) for a full-display capture, or the returned `to_screen` formula with coordinate_type "screen" for a region capture. Cached like screenshot; pass force_refresh: true if the screen may have changed outside these tools.',
      inputSchema: {
        display_index: z.number().default(0).describe("Display index to capture. Default: 0 (main display)."),
        region: regionSchema.optional(),
        reason: z.string().optional().describe('Why this screenshot is being taken (e.g., "verify the dialog closed").'),
        max_edge: z
          .number()
          .min(320)
          .max(4096)
          .default(DEFAULT_MAX_EDGE)
          .describe(`Downscale so the longer edge is at most this many pixels (default ${DEFAULT_MAX_EDGE}). Raise it only if small text is unreadable.`),
        force_refresh: z.boolean().default(false).describe("Bypass the capture cache and capture fresh."),
      },
    },
    async ({ display_index, region, reason, max_edge, force_refresh }) => {
      const target = resolveRegion(region, display_index);
      if ("error" in target) return fail(target.error);

      const [raw, redaction] = await Promise.all([
        captureRegion(target.x, target.y, target.width, target.height, force_refresh),
        passwordMasks(target),
      ]);
      const png = encodePng(raw, { maxEdge: max_edge, masks: redaction.masks });

      const meta = {
        image_width: png.width,
        image_height: png.height,
        source_width: target.width,
        source_height: target.height,
        scale: Number(png.scale.toFixed(4)),
        display_index: region ? null : display_index,
        to_screen: `screen_x = ${target.x} + px / ${png.scale.toFixed(4)}, screen_y = ${target.y} + py / ${png.scale.toFixed(4)}`,
        redaction: redaction.record,
        ...(reason ? { reason } : {}),
      };

      return {
        content: [
          { type: "image" as const, data: Buffer.from(png.data).toString("base64"), mimeType: "image/png", _meta: { redaction: redaction.record } },
          { type: "text" as const, text: JSON.stringify(meta, null, 2) },
        ],
      };
    },
  );
}
