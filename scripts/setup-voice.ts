/**
 * Dev/build setup for the voice trigger (prompts/stage-4-voice-hotkey-trigger.md):
 *   - unpacks whisper-server.exe (+ CUDA DLLs) into build/whisper/ — dev runs it from there and
 *     electron-builder ships that folder as an extraResource;
 *   - unless --no-model, downloads the configured speech model into <userData>/voice/ (the same
 *     place the app itself fetches it on first run).
 * Idempotent: anything already present is skipped.
 *
 *   bun run setup:voice [--no-model] [--model <name>]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WHISPER_CUDA_RUNTIME_DLL,
  WHISPER_SERVER_EXE,
  WHISPER_SERVER_ZIP,
  WHISPER_SERVER_ZIP_URL,
  downloadFile,
  fileExists,
  isValidModelName,
  modelPath,
  modelUrl,
} from "../src/main/perception/voice-assets";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "build", "whisper");
const downloadDir = path.join(root, "build", "whisper-dl");
const args = process.argv.slice(2);
const wantModel = !args.includes("--no-model");
const modelName = args.includes("--model") ? (args[args.indexOf("--model") + 1] ?? "") : "large-v3-turbo-q5_0";

function progressLogger(label: string) {
  let last = -1;
  return (received: number, total: number | null) => {
    if (!total) return;
    const percent = Math.floor((received / total) * 100);
    if (percent >= last + 10) {
      last = percent - (percent % 10);
      console.log(`${label} ${percent}% (${Math.round(received / 1e6)}/${Math.round(total / 1e6)} MB)`);
    }
  };
}

/** Finds whisper-server.exe anywhere under `dir` (the zip nests it under Release/). */
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

async function setupServer(): Promise<void> {
  // The cuBLAS DLL check upgrades an older CPU-only (11.8) install in place.
  if (fileExists(path.join(serverDir, WHISPER_SERVER_EXE)) && fileExists(path.join(serverDir, WHISPER_CUDA_RUNTIME_DLL))) {
    console.log(`whisper server already present: ${serverDir}`);
    return;
  }
  const zip = path.join(downloadDir, WHISPER_SERVER_ZIP);
  if (!fileExists(zip)) {
    console.log(`downloading ${WHISPER_SERVER_ZIP_URL}`);
    await downloadFile(WHISPER_SERVER_ZIP_URL, zip, progressLogger("whisper server"));
  }
  const extracted = path.join(downloadDir, "extracted");
  rmSync(extracted, { recursive: true, force: true });
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extracted}' -Force`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("failed to extract the whisper server zip");

  const exe = findFile(extracted, WHISPER_SERVER_EXE);
  if (!exe) throw new Error(`${WHISPER_SERVER_EXE} not found inside ${WHISPER_SERVER_ZIP}`);
  // The server plus the DLLs next to it (CUDA/cuBLAS, ggml) — not the zip's other tools
  // (bench, stream, test-*), which would only bloat the installer.
  rmSync(serverDir, { recursive: true, force: true });
  mkdirSync(serverDir, { recursive: true });
  const sourceDir = path.dirname(exe);
  for (const entry of readdirSync(sourceDir)) {
    const from = path.join(sourceDir, entry);
    const wanted = entry.toLowerCase() === WHISPER_SERVER_EXE || entry.toLowerCase().endsWith(".dll");
    if (wanted && statSync(from).isFile()) copyFileSync(from, path.join(serverDir, entry));
  }
  rmSync(extracted, { recursive: true, force: true });
  console.log(`whisper server ready: ${serverDir}`);
}

async function setupModel(): Promise<void> {
  if (!isValidModelName(modelName)) throw new Error(`invalid model name "${modelName}"`);
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is not set");
  // Same folder the app resolves as <userData>/voice (userData = %APPDATA%/<package name>).
  const dest = modelPath(path.join(appData, "autonomouse_ai", "voice"), modelName);
  if (fileExists(dest)) {
    console.log(`model already present: ${dest}`);
    return;
  }
  console.log(`downloading ${modelUrl(modelName)}`);
  await downloadFile(modelUrl(modelName), dest, progressLogger("model"));
  console.log(`model ready: ${dest}`);
}

await setupServer();
if (wantModel) await setupModel();
