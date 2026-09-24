import * as z from "zod";
import { sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { text } from "../core/result";

const MAX_WAIT_MS = 60_000;

export function registerMiscTools(defineTool: DefineTool): void {
  defineTool(
    "echo",
    {
      description: "Echo a message back to the MCP client (connectivity check).",
      inputSchema: {
        message: z.string().describe("The message to echo."),
      },
    },
    ({ message }) => text(message),
  );

  defineTool(
    "wait",
    {
      description: `Wait for a duration in milliseconds (capped at ${MAX_WAIT_MS}ms) to let an application finish loading, animating, or updating — e.g. a dialog appearing, a menu rendering, a file loading. Prefer find_element / browser_wait_for when you can wait for something specific instead of a fixed time.`,
      inputSchema: {
        duration: z.number().positive().describe("Duration to wait in milliseconds (e.g., 1000 = 1 second)."),
        reason: z.string().optional().describe('Why waiting (e.g., "waiting for dialog to appear").'),
      },
    },
    async ({ duration, reason }, { signal }) => {
      const clamped = Math.min(duration, MAX_WAIT_MS);
      await Promise.race([sleep(clamped), new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return text(`Waited ${signal.aborted ? "(cancelled early)" : `${clamped}ms`}${reason ? ` (${reason})` : ""}.`);
    },
  );
}
