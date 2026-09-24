import { describe, expect, test } from "bun:test";
import { summarizeResult } from "./tool-executor";

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
