import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Where the voice trigger's two big binaries come from. Deliberately free of any Electron
 * import so the dev setup script (scripts/setup-voice.ts) and the app's first-run download
 * share one implementation. Neither file is committed or bundled in the installer's JS —
 * whisper-server.exe ships as an extraResource, the model is fetched on first run.
 */

// Pinned: "latest" would silently change the server's CLI/behavior under us.
export const WHISPER_RELEASE_TAG = "b5130";
// The 12.4 CUDA build is the one that bundles its own cuBLAS (cublas64_12.dll). The 11.8 build
// expects a locally installed CUDA toolkit, so on a stock machine ggml silently falls back to CPU.
export const WHISPER_SERVER_ZIP = "whisper-cublas-12.4.0-bin-x64.zip";
export const WHISPER_SERVER_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}/${WHISPER_SERVER_ZIP}`;
export const WHISPER_SERVER_EXE = "whisper-server.exe";
/** Shipped only by the GPU-capable build; its absence means an older (CPU-only) server is installed. */
export const WHISPER_CUDA_RUNTIME_DLL = "cublas64_12.dll";

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export function modelFileName(model: string): string {
  return `ggml-${model}.bin`;
}

export function modelUrl(model: string): string {
  return `${MODEL_BASE_URL}/${modelFileName(model)}`;
}

export function modelPath(voiceDir: string, model: string): string {
  return path.join(voiceDir, modelFileName(model));
}

/** A model name ends up in a file path and a URL — keep it to the characters real names use. */
export function isValidModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model);
}

export type DownloadProgress = (received: number, total: number | null) => void;

/**
 * Streams `url` to `dest` through a `.part` file and renames it on success, so a half-finished
 * download is never mistaken for a usable model. Follows redirects (Hugging Face and GitHub
 * both redirect to a CDN).
 */
export async function downloadFile(url: string, dest: string, onProgress?: DownloadProgress, signal?: AbortSignal): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length")) || null;

  let received = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });
  try {
    await pipeline(body, createWriteStream(part));
    if (total !== null && statSync(part).size !== total) throw new Error(`download truncated: got ${statSync(part).size} of ${total} bytes`);
    renameSync(part, dest);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}

export function fileExists(file: string): boolean {
  return existsSync(file) && statSync(file).size > 0;
}
