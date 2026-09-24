import * as z from "zod";
import type { DefineTool } from "../core/define-tool";
import { fail, json, text } from "../core/result";
import { runSystemControl } from "../powershell/workers";

export function registerSystemTools(defineTool: DefineTool): void {
  defineTool(
    "get_volume",
    {
      description: "Desktop automation tool (OS-level system control): get the current system master volume (0-100) and mute state.",
      inputSchema: {},
    },
    async () => {
      const result = await runSystemControl("get_volume");
      if (!result.ok) throw new Error(result.error ?? "Unknown error.");
      return json({ volume: result.volume, muted: result.muted });
    },
  );

  defineTool(
    "set_volume",
    {
      description:
        "Desktop automation tool (OS-level system control): set the system master volume to an exact level (0-100), and/or mute/unmute. Uses the Core Audio API directly, so it jumps straight to the level rather than stepping like a volume key.",
      inputSchema: {
        level: z.number().min(0).max(100).optional().describe("Target volume, 0-100. Omit to only change mute state."),
        muted: z.boolean().optional().describe("Set mute state. Omit to leave it unchanged."),
      },
    },
    async ({ level, muted }) => {
      if (level === undefined && muted === undefined) return fail("Provide level and/or muted.");
      const result = await runSystemControl("set_volume", { level, muted });
      if (!result.ok) throw new Error(result.error ?? "Unknown error.");
      return text(`Volume set to ${result.volume}${result.muted ? " (muted)" : ""}.`);
    },
  );

  defineTool(
    "get_brightness",
    {
      description:
        "Desktop automation tool (OS-level system control): get the current display brightness (0-100) via WMI. Only supported on displays that expose WmiMonitorBrightness (typically laptop panels) — check `supported` before relying on `brightness`.",
      inputSchema: {},
    },
    async () => {
      const result = await runSystemControl("get_brightness");
      if (!result.ok) throw new Error(result.error ?? "Unknown error.");
      return json({ supported: result.supported, brightness: result.brightness });
    },
  );

  defineTool(
    "set_brightness",
    {
      description:
        "Desktop automation tool (OS-level system control): set display brightness to an exact level (0-100) via WMI. Only works on displays exposing WmiMonitorBrightnessMethods (typically laptop panels, not external monitors); physical Fn+brightness keys are NOT a fallback.",
      inputSchema: {
        level: z.number().min(0).max(100).describe("Target brightness, 0-100."),
      },
    },
    async ({ level }) => {
      const result = await runSystemControl("set_brightness", { level });
      if (!result.supported) {
        return fail(`This display does not support WMI brightness control (no WmiMonitorBrightnessMethods). ${result.error ?? ""}`.trim());
      }
      if (!result.ok) throw new Error(result.error ?? "Unknown error.");
      return text(`Brightness set to ${result.brightness}.`);
    },
  );
}
