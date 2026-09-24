import { dlopen, FFIType, type Library } from "bun:ffi";

// Win32 bindings via bun:ffi — no native npm modules, nothing to rebuild against an ABI. This
// is also why the MCP server has to be its own Bun process: bun:ffi doesn't exist inside
// Electron's Node runtime.

const USER32_SYMBOLS = {
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.bool },
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  EnumDisplayMonitors: { args: [FFIType.ptr, FFIType.ptr, FFIType.function, FFIType.i64], returns: FFIType.bool },
  SetProcessDPIAware: { args: [], returns: FFIType.bool },
  GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
  GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
  GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
  ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  OpenClipboard: { args: [FFIType.ptr], returns: FFIType.bool },
  CloseClipboard: { args: [], returns: FFIType.bool },
  EmptyClipboard: { args: [], returns: FFIType.bool },
  SetClipboardData: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
  GetClipboardData: { args: [FFIType.u32], returns: FFIType.ptr },
  IsClipboardFormatAvailable: { args: [FFIType.u32], returns: FFIType.bool },
} as const;

const SHCORE_SYMBOLS = {
  GetDpiForMonitor: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;

const KERNEL32_SYMBOLS = {
  GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.ptr },
  GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
  GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.bool },
  GlobalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

const GDI32_SYMBOLS = {
  CreateCompatibleDC: { args: [FFIType.ptr], returns: FFIType.ptr },
  CreateCompatibleBitmap: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
  SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  BitBlt: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.u32],
    returns: FFIType.bool,
  },
  GetDIBits: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  DeleteDC: { args: [FFIType.ptr], returns: FFIType.bool },
  DeleteObject: { args: [FFIType.ptr], returns: FFIType.bool },
} as const;

let user32Lib: Library<typeof USER32_SYMBOLS> | null = null;
let shcoreLib: Library<typeof SHCORE_SYMBOLS> | null = null;
let kernel32Lib: Library<typeof KERNEL32_SYMBOLS> | null = null;
let gdi32Lib: Library<typeof GDI32_SYMBOLS> | null = null;

export function getUser32() {
  if (!user32Lib) {
    user32Lib = dlopen("user32.dll", USER32_SYMBOLS);
    // Without this, Windows reports scaled/virtualized coordinates for an unaware process,
    // which throws off click precision on scaled displays.
    user32Lib.symbols.SetProcessDPIAware();
  }
  return user32Lib.symbols;
}

export function getShcore() {
  if (!shcoreLib) shcoreLib = dlopen("shcore.dll", SHCORE_SYMBOLS);
  return shcoreLib.symbols;
}

export function getKernel32() {
  if (!kernel32Lib) kernel32Lib = dlopen("kernel32.dll", KERNEL32_SYMBOLS);
  return kernel32Lib.symbols;
}

export function getGdi32() {
  if (!gdi32Lib) gdi32Lib = dlopen("gdi32.dll", GDI32_SYMBOLS);
  return gdi32Lib.symbols;
}

export type User32 = ReturnType<typeof getUser32>;
export type Kernel32 = ReturnType<typeof getKernel32>;
