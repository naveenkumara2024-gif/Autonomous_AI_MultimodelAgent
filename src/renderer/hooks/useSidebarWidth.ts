import { useCallback, useState } from "react";

// The sidebar is one continuous adjustable value, not a separate
// open/collapsed boolean plus a width: dragging it down doesn't hit a wall
// at some "minimum expanded" size, it keeps going down to an icon-only rail
// (just wide enough for the home + new-session icons) instead of vanishing.
export const SIDEBAR_ICON_WIDTH = 60;
export const SIDEBAR_COLLAPSE_THRESHOLD = 60;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 256; // matches the old fixed w-64

const WIDTH_KEY = "sidebar-width";
const PREFERRED_WIDTH_KEY = "sidebar-preferred-width";

function clamp(width: number): number {
  // No dead zone between the icon rail and the collapse threshold: anything
  // dragged at or below the threshold snaps straight to the rail width, so
  // the container is never sitting at some in-between size — icon-only
  // content rendered inside a wider-than-the-icons box is exactly the "huge
  // gap" bug this closes. It's one or the other, never something between.
  if (width <= SIDEBAR_COLLAPSE_THRESHOLD) {
    return SIDEBAR_ICON_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, width);
}

function readStored(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // per-viewer convenience only — safe to no-op if storage is unavailable
  }
}

export function useSidebarWidth() {
  const [width, setWidthState] = useState<number>(() => readStored(WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH));
  const [preferredWidth, setPreferredWidth] = useState<number>(() =>
    readStored(PREFERRED_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH),
  );

  const setWidth = useCallback((next: number) => {
    const clamped = clamp(next);
    setWidthState(clamped);
    persist(WIDTH_KEY, clamped);
    // Only remember as "preferred" while above the collapse threshold, so
    // toggling/collapsing to the icon rail doesn't overwrite what the user
    // actually wants to come back to.
    if (clamped > SIDEBAR_COLLAPSE_THRESHOLD) {
      setPreferredWidth(clamped);
      persist(PREFERRED_WIDTH_KEY, clamped);
    }
  }, []);

  const isCollapsed = width <= SIDEBAR_COLLAPSE_THRESHOLD;

  const toggleCollapsed = useCallback(() => {
    setWidth(isCollapsed ? preferredWidth : SIDEBAR_ICON_WIDTH);
  }, [isCollapsed, preferredWidth, setWidth]);

  return { width, setWidth, isCollapsed, toggleCollapsed };
}
