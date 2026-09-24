import { ptr } from "bun:ffi";
import type { User32 } from "./ffi";

// --- SendInput INPUT structs (x64 layout) ---

const INPUT_SIZE = 40; // sizeof(INPUT) on x64
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x1000;
export const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
export const WHEEL_DELTA = 120;

export const VK_CONTROL = 0x11;
export const VK_V = 0x56;
export const VK_RETURN = 0x0d;

// Windows-only project (no mac aliases like command/cmd/option — see project memory).
const MODIFIER_VK: Record<string, number> = {
  win: 0x5b, // VK_LWIN
  windows: 0x5b,
  meta: 0x5b,
  shift: 0x10, // VK_SHIFT
  alt: 0x12, // VK_MENU
  control: 0x11, // VK_CONTROL
  ctrl: 0x11,
};

const KEY_VK: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

export function resolveKeyVk(key: string): number | undefined {
  const named = KEY_VK[key.toLowerCase()];
  if (named !== undefined) return named;
  // A modifier pressed on its own is a real key too — "win" alone opens the Start menu. The
  // reference server only accepted these in `modifiers`, so key_press("win") failed.
  const modifier = MODIFIER_VK[key.toLowerCase()];
  if (modifier !== undefined) return modifier;
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    // VK_0-VK_9 and VK_A-VK_Z happen to match ASCII codes for digits and uppercase letters.
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return code;
  }
  return undefined;
}

export function resolveModifiers(modifiers: string[]): number[] | { error: string } {
  const vks: number[] = [];
  for (const modifier of modifiers) {
    const vk = MODIFIER_VK[modifier.toLowerCase()];
    if (vk === undefined) return { error: `Unknown modifier key: "${modifier}". Use ctrl, shift, alt, or win.` };
    vks.push(vk);
  }
  return vks;
}

export function makeMouseInput(flags: number, mouseData = 0): Uint8Array {
  const buf = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, INPUT_MOUSE, true);
  dv.setInt32(8, 0, true); // dx
  dv.setInt32(12, 0, true); // dy
  dv.setInt32(16, mouseData, true); // mouseData (wheel delta lives in the signed low word)
  dv.setUint32(20, flags, true); // dwFlags
  dv.setUint32(24, 0, true); // time
  dv.setBigUint64(32, 0n, true); // dwExtraInfo
  return buf;
}

export function makeKeyInput(vk: number, flags: number): Uint8Array {
  const buf = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, INPUT_KEYBOARD, true);
  dv.setUint16(8, vk, true); // wVk
  dv.setUint16(10, 0, true); // wScan
  dv.setUint32(12, flags, true); // dwFlags
  dv.setUint32(16, 0, true); // time
  dv.setBigUint64(24, 0n, true); // dwExtraInfo
  return buf;
}

export function makeUnicodeKeyInput(charCode: number, keyUp: boolean): Uint8Array {
  const buf = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, INPUT_KEYBOARD, true);
  dv.setUint16(8, 0, true); // wVk = 0 signals a raw Unicode character in wScan
  dv.setUint16(10, charCode, true); // wScan
  dv.setUint32(12, KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0), true);
  dv.setUint32(16, 0, true); // time
  dv.setBigUint64(24, 0n, true); // dwExtraInfo
  return buf;
}

export function sendInputs(user32: User32, inputs: Uint8Array[]): void {
  const combined = new Uint8Array(inputs.length * INPUT_SIZE);
  inputs.forEach((input, i) => combined.set(input, i * INPUT_SIZE));
  const sent = user32.SendInput(inputs.length, ptr(combined), INPUT_SIZE);
  if (sent !== inputs.length) {
    throw new Error(`SendInput only queued ${sent}/${inputs.length} input events.`);
  }
}

/** Modifier down → body → modifier up (reverse order), the pattern click/key_press share. */
export function withModifiers(heldVks: number[], body: Uint8Array[]): Uint8Array[] {
  return [
    ...heldVks.map((vk) => makeKeyInput(vk, 0)),
    ...body,
    ...[...heldVks].reverse().map((vk) => makeKeyInput(vk, KEYEVENTF_KEYUP)),
  ];
}
