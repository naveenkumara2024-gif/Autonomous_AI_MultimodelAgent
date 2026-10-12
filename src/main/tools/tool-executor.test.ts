import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TurnTrace } from "../agent/trace";
import { ResourceLockManager } from "../sandbox/resource-lock-manager";
import { type ExecutorDeps, parseOwnWindowBlock, summarizeResult, ToolExecutor } from "./tool-executor";

describe("summarizeResult (the ⎿ line under a trace row)", () => {
  test("PowerShell results show exit code and first output line", () => {
    const text = JSON.stringify({ exit_code: 0, stdout: "\r\nName    Length\r\n----    ------\r\na.txt   12", stderr: "", timed_out: false, cancelled: false });
    expect(summarizeResult(text)).toBe("exit 0 — Name    Length (+2 lines)");
  });

  test("failed commands fall back to stderr; timeouts say so", () => {
    expect(summarizeResult(JSON.stringify({ exit_code: 1, stdout: "", stderr: "Get-Item : Cannot find path", timed_out: false }))).toBe("exit 1 — Get-Item : Cannot find path");
    expect(summarizeResult(JSON.stringify({ exit_code: null, stdout: "", stderr: "", timed_out: true }))).toBe("timed out — no output");
  });

  test("element lookups say what was found", () => {
    expect(summarizeResult(JSON.stringify({ found: true, name: "Save", control_type: "ControlType.Button" }))).toBe('found ControlType.Button "Save"');
    expect(summarizeResult(JSON.stringify({ found: false }))).toBe("not found");
  });

  test("navigation shows title and URL; arrays show a count; plain text shows its first line", () => {
    expect(summarizeResult(JSON.stringify({ url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto - Wikipedia" }))).toBe("Kyoto - Wikipedia — https://en.wikipedia.org/wiki/Kyoto");
    expect(summarizeResult(JSON.stringify([{}, {}]))).toBe("2 items");
    expect(summarizeResult("Performed single click at (10, 20) on display 0.\nmore")).toBe("Performed single click at (10, 20) on display 0.");
  });
});

// --- Automation overlay: self-approval guard, dodge-and-retry ---------------------------------

const BLOCKED = "Refused: (1700, 100) is inside the Autonomous AI app's own window. Nothing was clicked. [blocked-by-own-window x=1700 y=100]";
const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

function overlayHarness(opts: { clicks: CallToolResult[]; dodge?: ExecutorDeps["dodgeOverlay"]; inputBlocked?: () => string | null }) {
  const calls: string[] = [];
  const clicks = [...opts.clicks];
  const deps: ExecutorDeps = {
    mcp: {
      callTool: async (name: string) => {
        calls.push(name);
        if (name === "find_element") return textResult(JSON.stringify({ found: false }));
        return clicks.shift() ?? textResult("Done.");
      },
    } as unknown as ExecutorDeps["mcp"],
    approvals: { request: async () => "approved" } as unknown as ExecutorDeps["approvals"],
    locks: new ResourceLockManager(),
    policy: () => ({ allowScreenshotsToModel: true }),
    dodgeOverlay: opts.dodge,
    inputBlockedReason: opts.inputBlocked,
  };
  const trace = { emit: () => "trace-id", saveImage: () => ({ path: "", mimeType: "image/png" }), recordToolExecution: () => {} } as unknown as TurnTrace;
  const executor = new ToolExecutor(deps, { sessionId: "s", turnId: "t", trace, signal: new AbortController().signal });
  return { executor, calls };
}

const call = (tool: string, rawArgs: Record<string, unknown>) => ({ tool, rawArgs, reasoningTrace: "", subagent: "desktop", parentTraceId: null });

describe("parseOwnWindowBlock", () => {
  test("reads the refused point out of the MCP server's refusal", () => {
    expect(parseOwnWindowBlock(BLOCKED)).toEqual({ x: 1700, y: 100 });
    expect(parseOwnWindowBlock("[blocked-by-own-window x=-20 y=5]")).toEqual({ x: -20, y: 5 });
  });
  test("ignores any other text", () => {
    expect(parseOwnWindowBlock("Performed single click at (1, 2).")).toBeNull();
  });
});

describe("click refused because the overlay covers the target", () => {
  const args = { x: 1700, y: 100, intent: "Close the window" };

  test("the overlay dodges and the same call is retried once", async () => {
    const dodged: Array<{ x: number; y: number }> = [];
    const { executor, calls } = overlayHarness({
      clicks: [textResult(BLOCKED, true), textResult("Performed single click at (1700, 100) on display 0.")],
      dodge: (p) => (dodged.push(p), true),
    });
    const out = await executor.execute(call("click", args));
    expect(out.status).toBe("ok");
    expect(dodged).toEqual([{ x: 1700, y: 100 }]);
    expect(calls.filter((c) => c === "click")).toHaveLength(2);
    expect(out.text).toContain("overlay was covering that point");
    expect(out.text).toContain("Performed single click");
  });

  test("when the overlay was not the one covering it (or can't move), the refusal goes back unchanged", async () => {
    const { executor, calls } = overlayHarness({ clicks: [textResult(BLOCKED, true)], dodge: () => false });
    const out = await executor.execute(call("click", args));
    expect(out.status).toBe("error");
    expect(out.text).toContain("Nothing was clicked");
    expect(calls.filter((c) => c === "click")).toHaveLength(1);
  });

  test("a second refusal is reported, never retried again", async () => {
    const { executor, calls } = overlayHarness({ clicks: [textResult(BLOCKED, true), textResult(BLOCKED, true), textResult("Done.")], dodge: () => true });
    const out = await executor.execute(call("click", args));
    expect(out.status).toBe("error");
    expect(calls.filter((c) => c === "click")).toHaveLength(2);
  });

  test("without an overlay (no dodge hook) the refusal is simply reported", async () => {
    const { executor, calls } = overlayHarness({ clicks: [textResult(BLOCKED, true)] });
    const out = await executor.execute(call("click", args));
    expect(out.status).toBe("error");
    expect(calls.filter((c) => c === "click")).toHaveLength(1);
  });
});

describe("keyboard input while an approval is waiting and our window has focus", () => {
  test("key_press and type_text are refused before anything is sent", async () => {
    for (const tool of ["key_press", "type_text"]) {
      const { executor, calls } = overlayHarness({ clicks: [], inputBlocked: () => "Refused: an approval is waiting." });
      const out = await executor.execute(call(tool, tool === "key_press" ? { key: "enter" } : { text: "hi" }));
      expect(out.status).toBe("error");
      expect(out.text).toContain("approval is waiting");
      expect(calls).not.toContain(tool);
    }
  });

  test("other tools are unaffected, and input goes through when nothing blocks it", async () => {
    const blocked = overlayHarness({ clicks: [textResult("Performed single click at (1, 1).")], inputBlocked: () => "Refused." });
    expect((await blocked.executor.execute(call("click", { x: 1, y: 1 }))).status).toBe("ok");

    const free = overlayHarness({ clicks: [textResult("Pressed enter.")], inputBlocked: () => null });
    expect((await free.executor.execute(call("key_press", { key: "enter" }))).status).toBe("ok");
  });
});
