import { tmpdir } from "node:os";
import { join } from "node:path";
import systemControlScript from "./scripts/system-control.ps1" with { type: "text" };
import uiAutomationScript from "./scripts/ui-automation.ps1" with { type: "text" };
import { PsLineWorker } from "./line-worker";

// Scripts are bundled as text (so `bun build --compile` embeds them) and written to temp at
// worker start, because powershell.exe -File needs a real path.

export const uiAutomationWorker = new PsLineWorker(join(tmpdir(), "mcp-desktop-ui-automation.ps1"), uiAutomationScript);

// Password-field lookup for screenshot redaction gets its own process: a FindAll over a large
// window can be slow, and a timeout kills the worker — that must never cost find_element its
// warm process.
export const redactionWorker = new PsLineWorker(join(tmpdir(), "mcp-desktop-redaction.ps1"), uiAutomationScript);

export const systemControlWorker = new PsLineWorker(join(tmpdir(), "mcp-desktop-system-control.ps1"), systemControlScript);

export interface UiElement {
  found: boolean;
  error?: string;
  name?: string;
  automation_id?: string;
  control_type?: string;
  is_enabled?: boolean;
  has_keyboard_focus?: boolean;
  is_password?: boolean;
  bounding_rect?: { left: number; top: number; width: number; height: number };
  center?: { x: number; y: number };
}

export interface SystemControlResult {
  ok: boolean;
  error?: string;
  volume?: number;
  muted?: boolean;
  supported?: boolean;
  brightness?: number | null;
}

export function runSystemControl(action: string, params: Record<string, unknown> = {}): Promise<SystemControlResult> {
  return systemControlWorker.request<SystemControlResult>({ action, ...params });
}
