import path from "node:path";
import { WHISPER_SERVER_EXE } from "./voice-assets";

/**
 * Where whisper-server.exe lives. Packaged: electron-builder ships it (with its CUDA DLLs) in
 * resources/whisper/. Dev: `bun run setup:voice` unpacks the same files into build/whisper/.
 * Mirrors mcp/server-command.ts.
 */
export function resolveWhisperServerPath(options: { isPackaged: boolean; appRoot: string; resourcesPath: string }): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, "whisper", WHISPER_SERVER_EXE)
    : path.join(options.appRoot, "build", "whisper", WHISPER_SERVER_EXE);
}
