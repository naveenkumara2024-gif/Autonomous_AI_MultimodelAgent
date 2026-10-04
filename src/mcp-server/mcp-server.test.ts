import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Spawns the real server over stdio, exactly as the app's mcp-client.ts does. Only read-only
// tools are exercised — an automated test must never click, type, or change system state on
// the machine running it.

const EXPECTED_TOOLS = [
  // desktop — app memory
  "get_all_visited_apps", "init_app", "clear_click_history", "get_click_history",
  // desktop — app launching (stage 6)
  "launch_app",
  // desktop — input
  "click", "scroll", "drag", "move_mouse", "get_mouse_position", "type_text", "key_press",
  // desktop — screen / UIA / system
  "get_displays", "screenshot", "screenshot_for_display", "find_element",
  "get_volume", "set_volume", "get_brightness", "set_brightness",
  // misc
  "echo", "wait",
  // browser
  "browser_connect", "browser_list_tabs", "browser_new_tab", "browser_activate_tab", "browser_close_tab",
  "browser_navigate", "browser_find", "browser_click", "browser_type", "browser_get_text",
  "browser_wait_for", "browser_set_file_input", "browser_handle_dialog",
  "browser_extract_highlighted", "browser_clear_highlights", "browser_screenshot", "browser_evaluate",
  // new
  "run_powershell",
];

let client: Client;
let dataDir: string;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult, index = 0): string {
  const block = result.content[index];
  if (block?.type !== "text") throw new Error(`content[${index}] is ${block?.type}, not text`);
  return block.text;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcp-desktop-test-"));
  client = new Client({ name: "mcp-server-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(import.meta.dir, "index.ts")],
      env: { ...(process.env as Record<string, string>), MCP_DATA_DIR: dataDir },
      stderr: "ignore",
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mcp-desktop server", () => {
  test("exposes exactly the 38 reference tools plus run_powershell", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  test("get_displays reports at least one display with real dimensions", async () => {
    const displays = JSON.parse(textOf(await call("get_displays"))) as Array<{ width: number; height: number; isPrimary: boolean }>;
    expect(displays.length).toBeGreaterThan(0);
    expect(displays[0]!.isPrimary).toBe(true);
    expect(displays[0]!.width).toBeGreaterThan(0);
  });

  test("get_mouse_position returns numeric coordinates", async () => {
    const pos = JSON.parse(textOf(await call("get_mouse_position")));
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
  });

  test("screenshot_for_display returns a PNG with a redaction record", async () => {
    const result = await call("screenshot_for_display", { display_index: 0, max_edge: 800 });
    expect(result.isError).toBeFalsy();
    const image = result.content[0];
    if (image?.type !== "image") throw new Error("expected an image block");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(image._meta?.redaction).toBeDefined();
    const meta = JSON.parse(textOf(result, 1));
    expect(Math.max(meta.image_width, meta.image_height)).toBeLessThanOrEqual(800);
  }, 20_000);

  test("find_element focused:true answers without searching", async () => {
    const result = JSON.parse(textOf(await call("find_element", { focused: true })));
    expect(typeof result.found).toBe("boolean");
  }, 20_000);

  test("find_element at_point describes whatever is under a screen point", async () => {
    const pos = JSON.parse(textOf(await call("get_mouse_position")));
    const result = JSON.parse(textOf(await call("find_element", { at_point: { x: pos.x, y: pos.y } })));
    expect(result.point).toEqual({ x: pos.x, y: pos.y });
    expect(typeof result.found).toBe("boolean");
  }, 20_000);

  test("run_powershell returns stdout and exit code 0", async () => {
    const result = await call("run_powershell", { command: "Get-Date -Format yyyy" });
    const out = JSON.parse(textOf(result));
    expect(result.isError).toBeFalsy();
    expect(out.exit_code).toBe(0);
    expect(out.stdout).toMatch(/^\d{4}$/);
  }, 20_000);

  test("run_powershell reports a failing cmdlet as an error with exit code 1", async () => {
    const result = await call("run_powershell", { command: "Get-Item 'C:\\definitely\\not\\here.txt'" });
    const out = JSON.parse(textOf(result));
    expect(result.isError).toBe(true);
    expect(out.exit_code).toBe(1);
    expect(out.stderr.length).toBeGreaterThan(0);
  }, 20_000);

  test("run_powershell kills the command on timeout", async () => {
    const result = await call("run_powershell", { command: "Start-Sleep -Seconds 20", timeout_ms: 1500 });
    const out = JSON.parse(textOf(result));
    expect(out.timed_out).toBe(true);
    expect(out.duration_ms).toBeLessThan(10_000);
  }, 20_000);

  test("run_powershell preserves non-ASCII output", async () => {
    const out = JSON.parse(textOf(await call("run_powershell", { command: "Write-Output 'héllo 日本'" })));
    expect(out.stdout).toBe("héllo 日本");
  }, 20_000);
});
