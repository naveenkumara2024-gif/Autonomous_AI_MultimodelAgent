import { describe, expect, test } from "bun:test";
import { OWN_WINDOW_MARKER, ownWindowBlock, parseHostPid } from "./own-windows";

const probeReturning = (pid: number | null) => ({ pidAtPoint: () => pid });

describe("ownWindowBlock (self-approval guard)", () => {
  test("a point inside a window owned by the host is refused, with the marker the host parses", () => {
    const message = ownWindowBlock(100.4, 200.6, probeReturning(4242), 4242);
    expect(message).toContain(`[${OWN_WINDOW_MARKER} x=100 y=201]`);
    expect(message).toContain("Nothing was clicked");
  });

  test("a point over any other process's window is allowed", () => {
    expect(ownWindowBlock(10, 10, probeReturning(999), 4242)).toBeNull();
  });

  test("a point over no window at all is allowed", () => {
    expect(ownWindowBlock(10, 10, probeReturning(null), 4242)).toBeNull();
  });

  test("without a host PID the guard is off (standalone server)", () => {
    expect(ownWindowBlock(10, 10, probeReturning(4242), null)).toBeNull();
  });

  test("the probe receives the rounded integer point", () => {
    const seen: Array<[number, number]> = [];
    ownWindowBlock(1.5, -2.4, { pidAtPoint: (x, y) => (seen.push([x, y]), null) }, 1);
    expect(seen).toEqual([[2, -2]]);
  });
});

describe("parseHostPid", () => {
  test("accepts a positive integer string only", () => {
    expect(parseHostPid("1234")).toBe(1234);
    expect(parseHostPid("0")).toBeNull();
    expect(parseHostPid("12ab")).toBeNull();
    expect(parseHostPid("-5")).toBeNull();
    expect(parseHostPid(undefined)).toBeNull();
  });
});
