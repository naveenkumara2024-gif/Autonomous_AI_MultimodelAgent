import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The overlay window class talks to Electron, so it can't be exercised under `bun test`. What
// it must NEVER do can still be pinned: any call that activates the window turns it into the
// foreground window, which broke automation (keystrokes and UI Automation went to the overlay)
// and froze its own buttons while a task ran. See the class comment in automation-overlay.ts.

const source = readFileSync(path.join(import.meta.dir, "automation-overlay.ts"), "utf-8");
const code = source
  .split("\n")
  .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
  .join("\n");

describe("automation overlay never activates itself", () => {
  test("no moveTop() (SetWindowPos(HWND_TOP) without SWP_NOACTIVATE)", () => {
    expect(code).not.toMatch(/\.moveTop\s*\(/);
  });

  test("no focus()/show() (activating variants); only showInactive()", () => {
    expect(code).not.toMatch(/\.focus\s*\(/);
    expect(code).not.toMatch(/\.show\s*\(/);
    expect(code).toMatch(/\.showInactive\s*\(/);
  });

  test("no periodic z-order re-assertion", () => {
    expect(code).not.toMatch(/setInterval\s*\(/);
  });

  test("stays non-focusable", () => {
    expect(code).toMatch(/focusable:\s*false/);
  });
});
