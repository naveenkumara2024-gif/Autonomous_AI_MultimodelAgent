import { expect, test } from "bun:test";
import { resolveKeyVk, resolveModifiers } from "./input";

test("key_press accepts a modifier pressed on its own (win opens Start)", () => {
  expect(resolveKeyVk("win")).toBe(0x5b);
  expect(resolveKeyVk("Win")).toBe(0x5b);
  expect(resolveKeyVk("ctrl")).toBe(0x11);
  expect(resolveKeyVk("enter")).toBe(0x0d);
  expect(resolveKeyVk("a")).toBe(0x41);
  expect(resolveKeyVk("nonsense")).toBeUndefined();
});

test("modifiers still resolve for combinations like win+left", () => {
  expect(resolveModifiers(["win", "shift"])).toEqual([0x5b, 0x10]);
});
