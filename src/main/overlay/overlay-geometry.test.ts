import { describe, expect, test } from "bun:test";
import { defaultBounds, pickDodgeBounds, rectContains, resizeBounds, restoreBounds } from "./overlay-geometry";

const screen1 = { x: 0, y: 0, width: 1920, height: 1040 };
const screen2 = { x: 1920, y: 0, width: 1280, height: 1024 };
const SIZE = { width: 420, height: 540 };
const MIN = { width: 300, height: 160 };

describe("defaultBounds", () => {
  test("sits in the top-right of the work area with a margin", () => {
    expect(defaultBounds(screen1, SIZE, 16)).toEqual({ x: 1920 - 420 - 16, y: 16, width: 420, height: 540 });
  });

  test("shrinks to fit a small work area", () => {
    const small = { x: 0, y: 0, width: 400, height: 300 };
    const b = defaultBounds(small, SIZE, 16);
    expect(b.width).toBe(368);
    expect(b.height).toBe(268);
  });
});

describe("restoreBounds", () => {
  test("no saved state -> default placement on the primary display", () => {
    expect(restoreBounds(null, [screen1], screen1, SIZE, MIN, 16)).toEqual(defaultBounds(screen1, SIZE, 16));
  });

  test("saved bounds inside a display are kept as they were", () => {
    const saved = { x: 100, y: 120, width: 500, height: 600 };
    expect(restoreBounds(saved, [screen1, screen2], screen1, SIZE, MIN, 16)).toEqual(saved);
  });

  test("a saved window on a monitor that is gone falls back to the default", () => {
    const saved = { x: 2200, y: 100, width: 420, height: 540 };
    expect(restoreBounds(saved, [screen1], screen1, SIZE, MIN, 16)).toEqual(defaultBounds(screen1, SIZE, 16));
  });

  test("a window hanging off the edge is pulled back fully onto its display", () => {
    const saved = { x: 1800, y: 900, width: 420, height: 540 };
    const b = restoreBounds(saved, [screen1], screen1, SIZE, MIN, 16);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
    expect(b.y + b.height).toBeLessThanOrEqual(1040);
  });

  test("a saved size below the minimum is raised to it", () => {
    const b = restoreBounds({ x: 10, y: 10, width: 100, height: 100 }, [screen1], screen1, SIZE, MIN, 16);
    expect(b.width).toBe(MIN.width);
    expect(b.height).toBe(MIN.height);
  });

  test("garbage saved state is ignored", () => {
    const b = restoreBounds({ x: Number.NaN, y: 0, width: 1, height: 1 }, [screen1], screen1, SIZE, MIN, 16);
    expect(b).toEqual(defaultBounds(screen1, SIZE, 16));
  });
});

describe("pickDodgeBounds", () => {
  const bounds = { x: 1484, y: 16, width: 420, height: 540 };

  test("moves to the corner farthest from the covered point, and clears it", () => {
    const point = { x: 1700, y: 100 }; // e.g. a close button in the top-right of the target app
    const next = pickDodgeBounds(point, bounds, screen1, 16)!;
    expect(next).not.toBeNull();
    expect(rectContains(next, point)).toBe(false);
    // bottom-left is the farthest corner from the top-right.
    expect(next.x).toBe(16);
    expect(next.y).toBe(1040 - 540 - 16);
  });

  test("keeps the same size", () => {
    const next = pickDodgeBounds({ x: 1700, y: 100 }, bounds, screen1, 16)!;
    expect(next.width).toBe(420);
    expect(next.height).toBe(540);
  });

  test("returns null when no corner can clear the point", () => {
    const tiny = { x: 0, y: 0, width: 440, height: 560 };
    expect(pickDodgeBounds({ x: 220, y: 280 }, { x: 0, y: 0, width: 420, height: 540 }, tiny, 10)).toBeNull();
  });
});

describe("resizeBounds", () => {
  const start = { x: 1000, y: 100, width: 420, height: 540 };
  const min = { width: 300, height: 160 };

  test("dragging the bottom-right corner grows the window and keeps the top-left fixed", () => {
    expect(resizeBounds(start, "se", 50, 30, min)).toEqual({ x: 1000, y: 100, width: 470, height: 570 });
  });

  test("dragging the left edge moves x and keeps the right edge fixed", () => {
    const next = resizeBounds(start, "w", -80, 0, min);
    expect(next).toEqual({ x: 920, y: 100, width: 500, height: 540 });
    expect(next.x + next.width).toBe(start.x + start.width);
  });

  test("dragging the top edge moves y and keeps the bottom edge fixed", () => {
    const next = resizeBounds(start, "n", 0, 60, min);
    expect(next).toEqual({ x: 1000, y: 160, width: 420, height: 480 });
    expect(next.y + next.height).toBe(start.y + start.height);
  });

  test("never shrinks below the minimum, and the fixed edge stays put", () => {
    const next = resizeBounds(start, "nw", 900, 900, min);
    expect(next.width).toBe(300);
    expect(next.height).toBe(160);
    expect(next.x + next.width).toBe(start.x + start.width);
    expect(next.y + next.height).toBe(start.y + start.height);
  });

  test("respects a maximum size", () => {
    expect(resizeBounds(start, "e", 5000, 0, min, { width: 800, height: 900 }).width).toBe(800);
  });
});
