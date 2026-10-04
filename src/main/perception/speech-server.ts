import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Owns the local whisper.cpp HTTP server (whisper-server.exe) — the speech-to-text half of L2.
 * Shaped like mcp/mcp-client.ts: one app-wide child process, spawned lazily/warmed at boot,
 * health-checked, restarted on demand after a crash, never handed secrets in its environment.
 * Bound to 127.0.0.1 only: audio never leaves the device.
 */

export interface SpeechServerOptions {
  /** Full path to whisper-server.exe. */
  executable: string;
  /** Full path to the ggml model .bin. */
  modelPath: string;
  onLog?: (line: string) => void;
}

const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const START_TIMEOUT_MS = 90_000; // loading a ~550MB model onto the GPU
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_START_FAILURES = 3;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENV.test(key) && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not allocate a local port"))));
    });
  });
}

export class SpeechServer {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private lastStderr = "";

  constructor(private readonly options: SpeechServerOptions) {}

  get isReady(): boolean {
    return this.child !== null && this.child.exitCode === null && this.port !== 0 && !this.starting;
  }

  /** Idempotent: starts the server if it isn't running, otherwise returns immediately. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.isReady) return;
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async launch(): Promise<void> {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_START_FAILURES) {
      throw new Error(`speech server failed to start ${this.consecutiveFailures} times in a row: ${this.lastStderr || "no output"}`);
    }
    this.port = await freePort();
    this.lastStderr = "";
    const args = ["-m", this.options.modelPath, "--host", "127.0.0.1", "--port", String(this.port), "-l", "auto", "-nt"];
    const child = spawn(this.options.executable, args, {
      cwd: path.dirname(this.options.executable), // CUDA DLLs sit next to the exe
      env: childEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.lastStderr = (this.lastStderr + text).slice(-600);
      this.options.onLog?.(text.trimEnd());
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.port = 0;
        if (!this.stopped) this.options.onLog?.(`whisper-server exited (code ${code}); will restart on the next voice request`);
      }
    });

    try {
      await this.waitUntilHealthy(child);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      child.kill();
      if (this.child === child) {
        this.child = null;
        this.port = 0;
      }
      throw error;
    }
  }

  /** The server only starts listening after the model has loaded, so "reachable" == "ready". */
  private async waitUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`whisper-server exited with code ${child.exitCode} during startup: ${this.lastStderr || "no output"}`);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("whisper-server did not become ready in time");
  }

  /** Returns the transcript, or null when the model heard nothing. Throws if the server is unusable. */
  async transcribe(wav: Uint8Array): Promise<string | null> {
    await this.start();
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");

    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`whisper-server returned HTTP ${response.status}`);
    const body = (await response.json()) as { text?: unknown; error?: unknown };
    if (typeof body.error === "string") throw new Error(`whisper-server: ${body.error}`);
    const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
    return text.length > 0 ? text : null;
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.port = 0;
    child?.kill();
  }
}
