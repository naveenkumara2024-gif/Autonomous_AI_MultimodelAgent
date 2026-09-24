import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodeBmp, encodePng, type RawImage } from "./png";

/** Minimal decoder for what encodePng emits (8-bit RGB, filter type 1 on every row). */
function decode(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = dv.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      rgb[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + left) & 0xff;
    }
  }
  return { width, height, rgb };
}

/** Bottom-up BGRA image where pixel (x, y) (top-down) = rgb(x*10, y*10, 7). */
function gradient(width: number, height: number): RawImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      pixels[row + x * 4] = 7; // B
      pixels[row + x * 4 + 1] = y * 10; // G
      pixels[row + x * 4 + 2] = x * 10; // R
    }
  }
  return { width, height, pixels };
}

describe("encodePng", () => {
  test("round-trips pixels with rows flipped to top-down and BGR swapped to RGB", () => {
    const { data, width, height, scale } = encodePng(gradient(4, 3));
    expect(Array.from(data.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect({ width, height, scale }).toEqual({ width: 4, height: 3, scale: 1 });

    const decoded = decode(data);
    expect(Array.from(decoded.rgb.subarray(0, 3))).toEqual([0, 0, 7]); // (0,0)
    const p = (2 * 4 + 3) * 3; // (x=3, y=2)
    expect(Array.from(decoded.rgb.subarray(p, p + 3))).toEqual([30, 20, 7]);
  });

  test("downscales to fit max_edge and reports the scale", () => {
    const { width, height, scale } = encodePng(gradient(20, 10), { maxEdge: 10 });
    expect({ width, height, scale }).toEqual({ width: 10, height: 5, scale: 0.5 });
  });

  test("paints mask rects solid black", () => {
    const { data } = encodePng(gradient(4, 4), { masks: [{ x: 1, y: 1, width: 2, height: 2 }] });
    const { rgb } = decode(data);
    const at = (x: number, y: number) => Array.from(rgb.subarray((y * 4 + x) * 3, (y * 4 + x) * 3 + 3));
    expect(at(1, 1)).toEqual([0, 0, 0]);
    expect(at(2, 2)).toEqual([0, 0, 0]);
    expect(at(3, 3)).toEqual([30, 30, 7]);
  });

  test("encodeBmp keeps the reference server's BMP layout", () => {
    const raw = gradient(2, 2);
    const bmp = encodeBmp(raw);
    expect(bmp[0]).toBe(0x42);
    expect(bmp[1]).toBe(0x4d);
    expect(bmp.length).toBe(54 + raw.pixels.length);
  });
});
