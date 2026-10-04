import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SpeechServer } from "./speech-server";
import { modelPath } from "./voice-assets";
import { resolveWhisperServerPath } from "./voice-server-command";

// Real round-trip: spawns whisper-server.exe against the real model and feeds it the JFK sample.
// Needs `bun run setup:voice` to have been run; without the binaries it is skipped (and says so)
// rather than passing a check it did not run.

const appRoot = path.join(import.meta.dir, "..", "..", "..");
const executable = resolveWhisperServerPath({ isPackaged: false, appRoot, resourcesPath: "" });
const model = modelPath(path.join(process.env.APPDATA ?? "", "autonomouse_ai", "voice"), "large-v3-turbo-q5_0");
const available = existsSync(executable) && existsSync(model) && statSync(model).size > 0;

if (!available) console.warn(`[speech-server.test] SKIPPED: run "bun run setup:voice" (need ${executable} and ${model})`);

describe("speech server (real whisper-server.exe)", () => {
  test.skipIf(!available)(
    "transcribes jfk.wav",
    async () => {
      const server = new SpeechServer({ executable, modelPath: model });
      try {
        const wav = new Uint8Array(readFileSync(path.join(import.meta.dir, "fixtures", "jfk.wav")));
        const text = await server.transcribe(wav);
        expect(text?.toLowerCase()).toContain("ask not");
      } finally {
        server.stop();
      }
    },
    120_000,
  );
});
