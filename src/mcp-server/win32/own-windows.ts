import { ptr } from "bun:ffi";
import { getUser32 } from "./ffi";

// Self-approval guard (prompts/automation-overlay.md decision 15): the app's own windows — the
// main window and the always-on-top automation overlay — carry the Approve button for flagged
// actions. Synthetic input must never land on them, or an agent could approve its own request.
// The host (Electron main) passes its PID as AGENT_HOST_PID; every top-level window the app
// creates is owned by that process.

/** Appended to the refusal so the host can recognise it and move the overlay out of the way. */
export const OWN_WINDOW_MARKER = "blocked-by-own-window";

const GA_ROOT = 2;

export function parseHostPid(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return pid > 0 ? pid : null;
}

export interface OwnWindowProbe {
  /** PID owning the top-level window at a screen point, or null if there is none. */
  pidAtPoint(x: number, y: number): number | null;
}

/**
 * The refusal text when (x, y) is inside a window owned by the host; null when the point is fine
 * (or the guard is off because no host PID was given — e.g. the server run standalone).
 */
export function ownWindowBlock(x: number, y: number, probe: OwnWindowProbe, hostPid: number | null): string | null {
  if (hostPid === null) return null;
  const px = Math.round(x);
  const py = Math.round(y);
  if (probe.pidAtPoint(px, py) !== hostPid) return null;
  return `Refused: (${px}, ${py}) is inside the Autonomous AI app's own window (its automation overlay or main window), not the app you are automating. Nothing was clicked. [${OWN_WINDOW_MARKER} x=${px} y=${py}]`;
}

const realProbe: OwnWindowProbe = {
  pidAtPoint(x, y) {
    const user32 = getUser32();
    const packed = BigInt.asUintN(32, BigInt(x)) | (BigInt.asUintN(32, BigInt(y)) << 32n);
    const hwnd = user32.WindowFromPoint(BigInt.asIntN(64, packed));
    if (!hwnd) return null;
    const root = user32.GetAncestor(hwnd, GA_ROOT) || hwnd;
    const out = new Uint32Array(1);
    user32.GetWindowThreadProcessId(root, ptr(out));
    return out[0] || null;
  },
};

let cachedHostPid: number | null | undefined;

/** Guard for click/drag endpoints against the real desktop. Null = allowed. */
export function checkPointAgainstOwnWindows(x: number, y: number): string | null {
  cachedHostPid ??= parseHostPid(process.env.AGENT_HOST_PID);
  return ownWindowBlock(x, y, realProbe, cachedHostPid);
}
