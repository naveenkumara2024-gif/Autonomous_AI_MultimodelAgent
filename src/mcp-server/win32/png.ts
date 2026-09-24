import { deflateSync } from "node:zlib";

// Minimal PNG encoder (node:zlib only, no dependency). The reference server returned raw
// 32-bpp BMP screenshots: 8 MB for a 1080p frame, and not a format vision APIs accept.
// PNG of the same frame is typically 150-600 KB, and optional downscaling cuts it further —
// which matters, because every screenshot is sent to the model and billed as image tokens.

/** A GDI capture: 32-bpp BGRA pixels in bottom-up row order (DIB layout). */
export interface RawImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EncodedPng {
  data: Uint8Array;
  width: number;
  height: number;
  /** output pixels per source pixel (1 = full resolution). */
  scale: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of parts) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([typeBytes, data]));
  return out;
}

/** Bottom-up BGRA → top-down RGB, area-averaged down to fit `maxEdge` when smaller. */
function toRgb(raw: RawImage, maxEdge: number): { rgb: Uint8Array; width: number; height: number; scale: number } {
  const { width: sw, height: sh, pixels } = raw;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const rgb = new Uint8Array(dw * dh * 3);
  const srcRow = (y: number) => (sh - 1 - y) * sw * 4; // flip bottom-up rows

  if (dw === sw && dh === sh) {
    for (let y = 0; y < sh; y++) {
      const s = srcRow(y);
      const d = y * sw * 3;
      for (let x = 0; x < sw; x++) {
        rgb[d + x * 3] = pixels[s + x * 4 + 2]!;
        rgb[d + x * 3 + 1] = pixels[s + x * 4 + 1]!;
        rgb[d + x * 3 + 2] = pixels[s + x * 4]!;
      }
    }
    return { rgb, width: dw, height: dh, scale: 1 };
  }

  // Area averaging (box filter) keeps small UI text legible, unlike nearest-neighbor.
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = srcRow(sy);
        for (let sx = sx0; sx < sx1; sx++) {
          const p = row + sx * 4;
          b += pixels[p]!;
          g += pixels[p + 1]!;
          r += pixels[p + 2]!;
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      const d = (dy * dw + dx) * 3;
      rgb[d] = r / n;
      rgb[d + 1] = g / n;
      rgb[d + 2] = b / n;
    }
  }
  return { rgb, width: dw, height: dh, scale: dw / sw };
}

/**
 * Encodes a GDI capture as an 8-bit RGB PNG. `masks` (region-local source pixels) are painted
 * solid black AFTER scaling, expanded to whole output pixels, so no masked content can bleed
 * back in through the downscale averaging.
 */
export function encodePng(raw: RawImage, options: { maxEdge?: number; masks?: Rect[] } = {}): EncodedPng {
  const { rgb, width, height, scale } = toRgb(raw, options.maxEdge ?? Number.POSITIVE_INFINITY);

  for (const m of options.masks ?? []) {
    const x0 = Math.max(0, Math.floor(m.x * scale));
    const y0 = Math.max(0, Math.floor(m.y * scale));
    const x1 = Math.min(width, Math.ceil((m.x + m.width) * scale));
    const y1 = Math.min(height, Math.ceil((m.y + m.height) * scale));
    for (let y = y0; y < y1; y++) rgb.fill(0, (y * width + x0) * 3, (y * width + x1) * 3);
  }

  // Filter type 1 (Sub) on every row: cheap, and screenshots' long flat runs compress far
  // better as deltas than as raw values.
  const stride = width * 3;
  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const s = y * stride;
    const d = y * (stride + 1);
    filtered[d] = 1;
    for (let i = 0; i < stride; i++) {
      filtered[d + 1 + i] = (rgb[s + i]! - (i >= 3 ? rgb[s + i - 3]! : 0)) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level: 4 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    data.set(p, offset);
    offset += p.length;
  }
  return { data, width, height, scale };
}

/** The reference server's .bmp file layout, kept for callers that explicitly ask for .bmp. */
export function encodeBmp(raw: RawImage): Uint8Array {
  const { width, height, pixels } = raw;
  const bmp = new Uint8Array(14 + 40 + pixels.length);
  const dv = new DataView(bmp.buffer);
  dv.setUint16(0, 0x4d42, true); // 'BM'
  dv.setUint32(2, bmp.length, true); // bfSize
  dv.setUint32(10, 14 + 40, true); // bfOffBits
  dv.setUint32(14, 40, true); // biSize
  dv.setInt32(18, width, true); // biWidth
  dv.setInt32(22, height, true); // biHeight (positive = bottom-up)
  dv.setUint16(26, 1, true); // biPlanes
  dv.setUint16(28, 32, true); // biBitCount
  dv.setUint32(34, pixels.length, true); // biSizeImage
  bmp.set(pixels, 54);
  return bmp;
}
