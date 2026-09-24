import { JSCallback, ptr, read, type Pointer } from "bun:ffi";
import { getShcore, getUser32 } from "./ffi";

export interface DisplayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DisplayInfo extends DisplayRect {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  scaleFactor: number;
}

export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

// sizeof(MONITORINFOEXW): DWORD cbSize(4) + RECT rcMonitor(16) + RECT rcWork(16) + DWORD dwFlags(4) + WCHAR szDevice[32](64)
const MONITORINFOEXW_SIZE = 104;
const MONITORINFOF_PRIMARY = 0x1;
const MDT_EFFECTIVE_DPI = 0;

function queryDisplays(): DisplayInfo[] {
  const user32 = getUser32();
  const monitors: { hMonitor: Pointer; rect: DisplayRect }[] = [];

  const callback = new JSCallback(
    (hMonitor: Pointer, _hdcMonitor: Pointer, lprcMonitor: Pointer) => {
      monitors.push({
        hMonitor,
        rect: {
          left: read.i32(lprcMonitor, 0),
          top: read.i32(lprcMonitor, 4),
          right: read.i32(lprcMonitor, 8),
          bottom: read.i32(lprcMonitor, 12),
        },
      });
      return true;
    },
    { args: ["ptr", "ptr", "ptr", "i64"], returns: "bool" },
  );

  try {
    user32.EnumDisplayMonitors(null, null, callback, 0n);
  } finally {
    callback.close();
  }

  const infoBuf = new Uint8Array(MONITORINFOEXW_SIZE);
  const infoDv = new DataView(infoBuf.buffer);
  const dpiBuf = new Uint8Array(8); // UINT dpiX, UINT dpiY

  const displays: DisplayInfo[] = monitors.map(({ hMonitor, rect }) => {
    infoDv.setUint32(0, MONITORINFOEXW_SIZE, true); // cbSize
    user32.GetMonitorInfoW(hMonitor, ptr(infoBuf));
    const flags = infoDv.getUint32(36, true);
    let name = "";
    for (let i = 0; i < 32; i++) {
      const code = infoDv.getUint16(40 + i * 2, true);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }

    let scaleFactor = 1;
    try {
      const hr = getShcore().GetDpiForMonitor(hMonitor, MDT_EFFECTIVE_DPI, ptr(dpiBuf, 0), ptr(dpiBuf, 4));
      if (hr === 0) scaleFactor = new DataView(dpiBuf.buffer).getUint32(0, true) / 96;
    } catch {
      // Per-monitor DPI unavailable; default to 1.
    }

    return {
      index: 0,
      name,
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      isPrimary: (flags & MONITORINFOF_PRIMARY) !== 0,
      scaleFactor,
    };
  });

  // Main display (index 0) is always the one flagged primary by Windows.
  displays.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  displays.forEach((d, i) => {
    d.index = i;
  });
  return displays;
}

// Monitor enumeration + per-monitor DPI lookup cost a handful of FFI round-trips; layout
// essentially never changes mid-session, so cache it and let callers force a refresh.
let displaysCache: { data: DisplayInfo[]; timestamp: number } | null = null;
const DISPLAYS_CACHE_TTL_MS = 5000;

export function getDisplays(forceRefresh = false): DisplayInfo[] {
  const now = Date.now();
  if (!forceRefresh && displaysCache && now - displaysCache.timestamp < DISPLAYS_CACHE_TTL_MS) {
    return displaysCache.data;
  }
  const data = queryDisplays();
  displaysCache = { data, timestamp: now };
  return data;
}

export function displayContaining(displays: DisplayInfo[], x: number, y: number): DisplayInfo | undefined {
  return displays.find((d) => x >= d.left && x < d.right && y >= d.top && y < d.bottom);
}

export function invalidDisplayMessage(displayIndex: number, displays: DisplayInfo[]): string {
  return `Invalid display_index ${displayIndex}. ${displays.length} display(s) available (0-${displays.length - 1}).`;
}

// --- Coordinate resolution ---

export type CoordinateMode = "auto" | "absolute" | "normalized" | "screen";
export const COORDINATE_MODES = ["auto", "absolute", "normalized", "screen"] as const;

export type ResolvedPoint = { x: number; y: number; displayIndex: number };

function resolveLocalPoint(
  mode: Exclude<CoordinateMode, "screen">,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  let resolved = mode;
  if (resolved === "auto") {
    resolved = x >= 0 && x <= width && y >= 0 && y <= height ? "absolute" : "normalized";
  }
  if (resolved === "normalized") return { x: (x / 1000) * width, y: (y / 1000) * height };
  return { x, y };
}

/**
 * Resolves a tool's (coordinate_type, x, y, display_index) to a global virtual-screen point.
 * "screen" bypasses display lookup entirely, since those coordinates (e.g. find_element's UI
 * Automation results, or a cached click location) are already global.
 */
export function resolvePoint(
  coordinateType: CoordinateMode,
  x: number,
  y: number,
  displayIndex: number,
  displays: DisplayInfo[],
): ResolvedPoint | { error: string } {
  if (coordinateType === "screen") {
    const gx = Math.round(x);
    const gy = Math.round(y);
    return { x: gx, y: gy, displayIndex: displayContaining(displays, gx, gy)?.index ?? displayIndex };
  }

  const display = displays[displayIndex];
  if (!display) return { error: invalidDisplayMessage(displayIndex, displays) };
  const local = resolveLocalPoint(coordinateType, x, y, display.width, display.height);
  return { x: Math.round(display.left + local.x), y: Math.round(display.top + local.y), displayIndex: display.index };
}
