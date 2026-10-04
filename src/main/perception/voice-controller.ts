import path from "node:path";
import { app, session } from "electron";
import { registerHandler } from "../client-event-utils";
import type { AgentConfig } from "../config/config-store";
import type { SessionManager } from "../session/session-manager";
import { AudioPipeline, type VoiceState, wavDurationMs } from "./audio-pipeline";
import { GlobalHotkey } from "./global-hotkey";
import { OverlayWindow } from "./overlay-window";
import { SpeechServer } from "./speech-server";
import { downloadFile, fileExists, isValidModelName, modelPath, modelUrl } from "./voice-assets";
import { resolveWhisperServerPath } from "./voice-server-command";

export interface VoiceControllerDeps {
  config: AgentConfig;
  sessionManager: SessionManager;
  sendToMain: (channel: string, payload: unknown) => void;
  appRoot: string;
}

export interface VoiceController {
  stop(): void;
}

/** <userData>/voice — the model lives here, never in git or the installer. */
export function voiceDir(): string {
  return path.join(app.getPath("userData"), "voice");
}

/**
 * Electron wiring for the voice trigger (L1 hotkey + L2 capture/transcribe). All the
 * decisions live in audio-pipeline.ts; this file only connects it to the hotkey, the overlay
 * window, the whisper server and the session manager.
 */
export function startVoice(deps: VoiceControllerDeps): VoiceController {
  const { config, sessionManager } = deps;
  const log = (line: string) => console.log(`[voice] ${line}`);
  const noop: VoiceController = { stop() {} };

  if (!config.voiceEnabled) {
    log("disabled (voiceEnabled: false)");
    return noop;
  }
  if (!isValidModelName(config.voiceModel)) {
    log(`disabled: voiceModel "${config.voiceModel}" is not a valid model name`);
    return noop;
  }

  const executable = resolveWhisperServerPath({ isPackaged: app.isPackaged, appRoot: deps.appRoot, resourcesPath: process.resourcesPath });
  const model = modelPath(voiceDir(), config.voiceModel);
  const overlay = new OverlayWindow();
  const hotkey = new GlobalHotkey();
  const speech = new SpeechServer({ executable, modelPath: model, onLog: (line) => line && console.log(`[whisper] ${line.slice(0, 300)}`) });

  let activeSessionId: string | null = null;
  type ModelStatus = { kind: "ready" } | { kind: "downloading"; percent: number } | { kind: "failed"; message: string };
  let modelStatus: ModelStatus = fileExists(model) ? { kind: "ready" } : { kind: "downloading", percent: 0 };
  let serverError: string | null = null;

  const warmServer = () => {
    speech.start().then(
      () => {
        serverError = null;
        log("speech server ready");
      },
      (error) => {
        serverError = error instanceof Error ? error.message : String(error);
        log(`speech server failed to start: ${serverError}`);
      },
    );
  };

  if (!fileExists(executable)) {
    log(`whisper-server.exe not found at ${executable} (run \`bun run setup:voice\`)`);
  } else if (modelStatus.kind === "ready") {
    warmServer();
  }

  if (modelStatus.kind === "downloading") {
    log(`model missing; downloading ${config.voiceModel} to ${model}`);
    let lastLogged = -1;
    downloadFile(modelUrl(config.voiceModel), model, (received, total) => {
      const percent = total ? Math.floor((received / total) * 100) : 0;
      modelStatus = { kind: "downloading", percent };
      if (percent >= lastLogged + 10) {
        lastLogged = percent - (percent % 10);
        log(`model download ${percent}%`);
      }
    }).then(
      () => {
        modelStatus = { kind: "ready" };
        log("model downloaded");
        if (fileExists(executable)) warmServer();
      },
      (error) => {
        modelStatus = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
        log(`model download failed: ${modelStatus.message}`);
      },
    );
  }

  const unavailableReason = (): string | null => {
    if (!fileExists(executable)) return "Voice isn't installed (run bun run setup:voice)";
    if (modelStatus.kind === "downloading") return `Voice model is downloading (${modelStatus.percent}%)`;
    if (modelStatus.kind === "failed") return "Voice model download failed";
    if (serverError && !speech.isReady) return "Voice engine failed to start";
    return null;
  };

  const showState = (state: VoiceState) => {
    if (state.phase === "idle") {
      overlay.send("voice.state", state);
      overlay.hide();
      return;
    }
    overlay.show();
    overlay.send("voice.state", state);
  };

  const pipeline = new AudioPipeline({
    unavailableReason,
    transcribe: async (wav) => {
      const startedAt = Date.now();
      const text = await speech.transcribe(wav);
      log(`transcribed ${Math.round(wavDurationMs(wav) / 100) / 10}s of audio in ${Date.now() - startedAt}ms`);
      return text;
    },
    activeSessionId: () => activeSessionId,
    sessions: {
      isBusy: (id) => sessionManager.listSessions().find((s) => s.id === id)?.status === "running",
      create: () => sessionManager.createSession(),
      send: (id, text) => {
        const { message } = sessionManager.continueSession(id, text);
        // The typed-send path adds its own message locally; a voice send has to be pushed.
        deps.sendToMain("session.message", message);
      },
    },
    ui: {
      setState: showState,
      capture: (action) => overlay.send("voice.capture", { action }),
    },
    onDelivered: ({ sessionId, created, text }) => {
      log(`transcript delivered to session ${sessionId} (${created ? "new session" : "existing session"}, ${text.length} chars)`);
      if (created) deps.sendToMain("voice.focus-session", { sessionId });
    },
    onLog: log,
  });

  // The overlay is the only window that may drive recording, and the only one allowed a mic.
  const fromOverlay = (event: { sender: { id: number } }) => event.sender.id === overlay.webContentsId;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = "mediaTypes" in details ? (details.mediaTypes ?? []).every((t) => t === "audio") : false;
    callback(permission === "media" && contents?.id === overlay.webContentsId && audioOnly);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === "media" && contents?.id === overlay.webContentsId);

  registerHandler("voice.setTarget", (_e, sessionId: string | null) => {
    activeSessionId = typeof sessionId === "string" ? sessionId : null;
  });
  registerHandler("voice.toggle", (e) => {
    if (fromOverlay(e)) pipeline.toggle();
  });
  registerHandler("voice.cancel", (e) => {
    if (fromOverlay(e)) pipeline.cancel();
  });
  registerHandler("voice.captureError", (e, reason: string) => {
    if (fromOverlay(e)) pipeline.captureFailed(String(reason).slice(0, 120));
  });
  registerHandler("voice.submit", async (e, wav: Uint8Array) => {
    if (!fromOverlay(e) || !(wav instanceof Uint8Array)) return;
    await pipeline.submit(wav);
  });

  const hotkeyError = hotkey.register(config.voiceHotkey, () => pipeline.toggle());
  if (hotkeyError) log(`hotkey not registered: ${hotkeyError}`);
  else log(`hotkey ${config.voiceHotkey} registered`);

  return {
    stop() {
      hotkey.unregister();
      speech.stop();
      overlay.destroy();
    },
  };
}
