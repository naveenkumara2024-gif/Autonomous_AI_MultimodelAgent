import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutedCall } from "../tools/tool-executor";
import { ActionCache, buildRecipe, recipeKey } from "./action-cache";

function call(tool: string, args: Record<string, unknown>, extra: Partial<ExecutedCall> = {}): ExecutedCall {
  const stateChanging = ["click", "type_text", "key_press", "scroll", "move_mouse", "launch_app", "run_powershell", "browser_click", "browser_type", "browser_navigate"].includes(tool);
  return {
    tool, args, intent: `${tool} step`, subagent: "desktop", status: "ok", isError: false,
    resources: stateChanging ? ["x"] : [], verdict: "allow", riskCategory: null, context: {}, text: "Done.",
    ...extra,
  };
}
const found = (args: Record<string, unknown>, x: number, y: number) => call("find_element", args, { text: JSON.stringify({ found: true, center: { x, y } }) });
const launched = (name: string) => call("launch_app", { app_name: name }, { text: JSON.stringify({ action: "launched", confirmed: true }) });

describe("recipeKey", () => {
  test("normalizes case, whitespace and trailing punctuation", () => {
    expect(recipeKey("  Open Notepad   and type HELLO! ")).toBe("open notepad and type hello");
  });
  test("refuses context-dependent or trivially short requests", () => {
    expect(recipeKey("do it again")).toBeNull();
    expect(recipeKey("close that window please")).toBeNull();
    expect(recipeKey("open notepad")).toBeNull(); // < 3 words — fast paths cover these
  });
});

describe("buildRecipe", () => {
  test("a launch + UIA-anchored click + typing becomes a replayable recipe", () => {
    const steps = buildRecipe([
      launched("notepad"),
      call("screenshot_for_display", {}),
      found({ name: "Text editor", control_type: "Document" }, 500, 400),
      call("click", { x: 500, y: 400, coordinate_type: "screen" }),
      call("type_text", { text: "hello" }, { context: { focusedElement: { name: "Text editor", is_password: false } } }),
    ]);
    expect(steps).toEqual([
      { kind: "call", tool: "launch_app", args: { app_name: "notepad" }, intent: "launch_app step" },
      { kind: "anchored", tool: "click", args: {}, anchor: { name: "Text editor", control_type: "Document" }, intent: "click step" },
      { kind: "call", tool: "type_text", args: { text: "hello" }, intent: "type_text step" },
    ]);
  });

  test("a click at vision-derived coordinates makes the turn uncacheable", () => {
    expect(buildRecipe([launched("notepad"), call("screenshot_for_display", {}), call("click", { x: 152, y: 992, coordinate_type: "normalized" })])).toBeNull();
  });

  test("a find_element that found something unrelated doesn't anchor a click elsewhere", () => {
    expect(buildRecipe([found({ name: "File" }, 10, 10), call("click", { x: 300, y: 300, coordinate_type: "screen" })])).toBeNull();
  });

  test("typing into a password field is never stored", () => {
    expect(buildRecipe([launched("x"), call("type_text", { text: "hunter2" }, { context: { focusedElement: { is_password: true } } })])).toBeNull();
    expect(buildRecipe([launched("x"), call("type_text", { text: "4111 1111 1111 1111" }, { riskCategory: "payment", verdict: "block-until-approved" })])).toBeNull();
  });

  test("denied or failed actions make the turn uncacheable; failed observations are ignored", () => {
    expect(buildRecipe([launched("x"), call("key_press", { key: "delete" }, { status: "denied" })])).toBeNull();
    expect(buildRecipe([launched("x"), call("key_press", { key: "a" }, { status: "error", isError: true })])).toBeNull();
    expect(buildRecipe([call("screenshot_for_display", {}, { status: "error", isError: true }), launched("x")])).toHaveLength(1);
  });

  test("turns that read data (shell, page text) aren't cached — their answer depended on it", () => {
    expect(buildRecipe([launched("x"), call("run_powershell", { command: "Get-Date" })])).toBeNull();
    expect(buildRecipe([call("browser_navigate", { url: "https://x" }), call("browser_get_text", {})])).toBeNull();
  });

  test("browser steps with stale tab ids aren't cached; selector-based ones are", () => {
    expect(buildRecipe([call("browser_click", { selector: "#a", tab_id: "T1" })])).toBeNull();
    expect(buildRecipe([call("browser_navigate", { url: "https://x" }), call("browser_click", { selector: "#go" })])).toHaveLength(2);
  });

  test("a turn with no actual action (only looking) isn't a recipe", () => {
    expect(buildRecipe([found({ name: "OK" }, 1, 1), call("screenshot_for_display", {})])).toBeNull();
  });

  test("a launch_app that found nothing is dropped, not replayed", () => {
    const miss = call("launch_app", { app_name: "zzz" }, { text: JSON.stringify({ launched: false, found: false }) });
    expect(buildRecipe([miss, launched("notepad")])).toHaveLength(1);
  });
});

describe("ActionCache store", () => {
  const open = () => new ActionCache(new Database(":memory:") as unknown as DatabaseSync);
  const steps = [{ kind: "call" as const, tool: "key_press", args: { key: "a" }, intent: "press a" }];

  test("save / get round-trips; success updates stats", () => {
    const cache = open();
    cache.save("k", "Do the thing now", steps);
    cache.markSuccess("k", 400);
    cache.markSuccess("k", 200);
    const r = cache.get("k")!;
    expect(r.steps).toEqual(steps);
    expect(r.successes).toBe(2);
    expect(r.avgMs).toBe(300);
  });

  test("two consecutive failed replays evict the recipe; a success in between resets the count", () => {
    const cache = open();
    cache.save("k", "Do the thing now", steps);
    expect(cache.markFailure("k")).toBe(false);
    cache.markSuccess("k", 100);
    expect(cache.markFailure("k")).toBe(false);
    expect(cache.markFailure("k")).toBe(true);
    expect(cache.get("k")).toBeNull();
  });
});
