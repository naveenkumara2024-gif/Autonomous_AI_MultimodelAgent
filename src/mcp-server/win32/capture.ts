import { ptr } from "bun:ffi";
import { sleep } from "../core/async";
import { getGdi32, getKernel32, getUser32 } from "./ffi";
import type { RawImage } from "./png";

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;

function captureOnce(x: number, y: number, width: number, height: number): RawImage {
  const user32 = getUser32();
  const gdi32 = getGdi32();
  const kernel32 = getKernel32();

  const hdcScreen = user32.GetDC(null);
  if (!hdcScreen) throw new Error(`GetDC failed (GetLastError=${kernel32.GetLastError()}).`);
  try {
    const hdcMem = gdi32.CreateCompatibleDC(hdcScreen);
    if (!hdcMem) throw new Error("CreateCompatibleDC failed.");
    try {
      const hBitmap = gdi32.CreateCompatibleBitmap(hdcScreen, width, height);
      if (!hBitmap) throw new Error(`CreateCompatibleBitmap failed (GetLastError=${kernel32.GetLastError()}).`);
      try {
        const hOld = gdi32.SelectObject(hdcMem, hBitmap);
        if (!gdi32.BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY)) {
          const err = kernel32.GetLastError();
          gdi32.SelectObject(hdcMem, hOld);
          throw new Error(`BitBlt failed (GetLastError=${err}).`);
        }
        // GetDIBits needs the bitmap deselected from any DC before it can read its bits.
        gdi32.SelectObject(hdcMem, hOld);

        // BITMAPINFOHEADER, 32bpp BI_RGB, positive biHeight = bottom-up.
        const bmiBuf = new Uint8Array(40);
        const bmiDv = new DataView(bmiBuf.buffer);
        bmiDv.setUint32(0, 40, true); // biSize
        bmiDv.setInt32(4, width, true); // biWidth
        bmiDv.setInt32(8, height, true); // biHeight
        bmiDv.setUint16(12, 1, true); // biPlanes
        bmiDv.setUint16(14, 32, true); // biBitCount
        bmiDv.setUint32(16, 0, true); // biCompression = BI_RGB
        const pixelBytes = width * height * 4;
        bmiDv.setUint32(20, pixelBytes, true); // biSizeImage

        const pixels = new Uint8Array(pixelBytes);
        const scanLines = gdi32.GetDIBits(hdcScreen, hBitmap, 0, height, ptr(pixels), ptr(bmiBuf), DIB_RGB_COLORS);
        if (scanLines === 0) throw new Error(`GetDIBits failed (GetLastError=${kernel32.GetLastError()}).`);
        return { width, height, pixels };
      } finally {
        gdi32.DeleteObject(hBitmap);
      }
    } finally {
      gdi32.DeleteDC(hdcMem);
    }
  } finally {
    user32.ReleaseDC(null, hdcScreen);
  }
}

async function captureWithRetry(x: number, y: number, width: number, height: number): Promise<RawImage> {
  // The screen DC can transiently fail (invalid handle / zero scanlines) around desktop
  // compositor activity; a few short retries smooth that over without masking real failures.
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return captureOnce(x, y, width, height);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(100);
    }
  }
}

// Short-lived cache to dedupe back-to-back captures of the same region without repeating the
// capture. TTL is generous (5 min) because staleness is handled explicitly, not by keeping the
// window short: every state-changing tool (click/type_text/key_press/scroll/drag) calls
// invalidateCaptureCache() on success, so a capture taken after an action is never stale.
// Callers that need to bypass it (the screen changed outside these tools) pass force_refresh.
let cache: { key: string; image: RawImage; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function captureRegion(x: number, y: number, width: number, height: number, forceRefresh = false): Promise<RawImage> {
  const key = `${x},${y},${width},${height}`;
  const now = Date.now();
  if (!forceRefresh && cache && cache.key === key && now - cache.timestamp < CACHE_TTL_MS) return cache.image;
  const image = await captureWithRetry(x, y, width, height);
  cache = { key, image, timestamp: now };
  return image;
}

export function invalidateCaptureCache(): void {
  cache = null;
}
