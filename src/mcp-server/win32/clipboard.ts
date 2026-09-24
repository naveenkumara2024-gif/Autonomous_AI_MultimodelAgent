import { toArrayBuffer } from "bun:ffi";
import type { Kernel32, User32 } from "./ffi";

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;

export function setClipboardText(user32: User32, kernel32: Kernel32, text: string): void {
  if (!user32.OpenClipboard(null)) throw new Error("OpenClipboard failed.");
  try {
    user32.EmptyClipboard();
    const byteLength = (text.length + 1) * 2;
    const hMem = kernel32.GlobalAlloc(GMEM_MOVEABLE, BigInt(byteLength));
    if (!hMem) throw new Error("GlobalAlloc failed.");
    const locked = kernel32.GlobalLock(hMem);
    if (!locked) throw new Error("GlobalLock failed.");
    const view = new Uint16Array(toArrayBuffer(locked, 0, byteLength));
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
    view[text.length] = 0;
    kernel32.GlobalUnlock(hMem);
    // Ownership of hMem transfers to the system on success; must not free it ourselves.
    if (!user32.SetClipboardData(CF_UNICODETEXT, hMem)) throw new Error("SetClipboardData failed.");
  } finally {
    user32.CloseClipboard();
  }
}

export function readClipboardText(user32: User32, kernel32: Kernel32): string | null {
  if (!user32.OpenClipboard(null)) return null;
  try {
    if (!user32.IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
    const hMem = user32.GetClipboardData(CF_UNICODETEXT);
    if (!hMem) return null;
    const locked = kernel32.GlobalLock(hMem);
    if (!locked) return null;
    try {
      const byteLength = Number(kernel32.GlobalSize(hMem));
      const view = new Uint16Array(toArrayBuffer(locked, 0, byteLength));
      let text = "";
      for (const code of view) {
        if (code === 0) break;
        text += String.fromCharCode(code);
      }
      return text;
    } finally {
      kernel32.GlobalUnlock(hMem);
    }
  } finally {
    user32.CloseClipboard();
  }
}
