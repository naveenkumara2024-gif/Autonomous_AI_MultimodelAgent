// Pure window-placement maths for the automation overlay (no Electron import, so it is
// unit-testable). All values are DIPs, the unit Electron's BrowserWindow and `screen` use.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Top-right of the work area — away from the voice indicator, which sits bottom-right. */
export function defaultBounds(workArea: Rect, size: Size, margin: number): Rect {
  const width = Math.min(size.width, workArea.width - margin * 2);
  const height = Math.min(size.height, workArea.height - margin * 2);
  return { x: workArea.x + workArea.width - width - margin, y: workArea.y + margin, width, height };
}

export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Enough of the window must remain on a display for the user to be able to grab it. */
const MIN_VISIBLE = { width: 120, height: 40 };

/**
 * The bounds to open the overlay with: the saved ones, kept on the display they overlap most
 * (a monitor may have been unplugged or rearranged since), else the default placement.
 */
export function restoreBounds(saved: Rect | null, workAreas: Rect[], primary: Rect, size: Size, min: Size, margin: number): Rect {
  const fallback = defaultBounds(primary, size, margin);
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return fallback;

  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const area2 = overlapArea(saved, area);
    if (area2 > bestArea) {
      best = area;
      bestArea = area2;
    }
  }
  if (!best || bestArea < MIN_VISIBLE.width * MIN_VISIBLE.height) return fallback;

  const width = Math.min(Math.max(saved.width, min.width), best.width);
  const height = Math.min(Math.max(saved.height, min.height), best.height);
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/**
 * Where the overlay goes when it is covering a point the agent needs: the work-area corner whose
 * window stays clear of the point and is farthest from it. null when no corner clears the point.
 */
export function pickDodgeBounds(point: Point, bounds: Rect, workArea: Rect, margin: number): Rect | null {
  const width = Math.min(bounds.width, workArea.width - margin * 2);
  const height = Math.min(bounds.height, workArea.height - margin * 2);
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - height - margin;

  const pad = 8;
  let best: Rect | null = null;
  let bestDistance = -1;
  for (const [x, y] of [
    [right, top],
    [left, top],
    [right, bottom],
    [left, bottom],
  ] as const) {
    const candidate = { x, y, width, height };
    if (rectContains({ x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 }, point)) continue;
    const distance = Math.hypot(x + width / 2 - point.x, y + height / 2 - point.y);
    if (distance > bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * New bounds for dragging `edge` by (dx, dy) from `start`, never smaller than `min` (nor larger
 * than `max`). The edge opposite the one being dragged stays where it is.
 */
export function resizeBounds(start: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size, max?: Size): Rect {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let width = start.width;
  let height = start.height;
  if (edge.includes("e")) width = start.width + dx;
  if (edge.includes("w")) width = start.width - dx;
  if (edge.includes("s")) height = start.height + dy;
  if (edge.includes("n")) height = start.height - dy;

  width = Math.min(Math.max(width, min.width), max?.width ?? Number.POSITIVE_INFINITY);
  height = Math.min(Math.max(height, min.height), max?.height ?? Number.POSITIVE_INFINITY);

  const x = edge.includes("w") ? right - width : start.x;
  const y = edge.includes("n") ? bottom - height : start.y;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
