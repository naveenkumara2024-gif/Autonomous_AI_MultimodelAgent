import { existsSync, statSync } from "node:fs";

// One-shot PowerShell execution for run_powershell. Deliberately a FRESH process per command
// (unlike the persistent workers): an agent's arbitrary commands shouldn't leak state (vars,
// cwd, loaded modules) into each other, output framing can't desync, and a timeout can always
// be enforced by killing the whole process tree.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_STREAM_CHARS = 30_000;

export interface PowerShellResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  cancelled: boolean;
  truncated: boolean;
  duration_ms: number;
  cwd: string;
}

/** Keeps the first and last half of a stream, so huge outputs can't exhaust memory. */
class CappedText {
  private head = "";
  private tail = "";
  private total = 0;
  private readonly half = MAX_STREAM_CHARS / 2;

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-this.half);
  }

  get truncated(): boolean {
    return this.total > MAX_STREAM_CHARS;
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n…[${this.total - MAX_STREAM_CHARS} characters omitted]…\n${this.tail}`;
  }
}

async function collect(stream: ReadableStream<Uint8Array>, sink: CappedText): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    sink.push(decoder.decode(chunk, { stream: true }));
  }
  sink.push(decoder.decode());
}

/**
 * Wraps the user command so the process reports a meaningful exit code: a native command's
 * non-zero $LASTEXITCODE wins; otherwise any error record raised during the command (including
 * non-terminating ones like "path not found") yields 1. UTF-8 output is forced so non-ASCII
 * paths and text survive the pipe.
 */
function buildScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$Error.Clear()",
    command,
    "if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "if ($Error.Count -gt 0) { exit 1 }",
    "exit 0",
  ].join("\n");
}

function killTree(pid: number): void {
  // proc.kill() only ends powershell.exe itself; anything it launched (a build, a server) would
  // survive and keep holding the pipes open. taskkill /T takes the whole tree.
  try {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

export async function runPowerShell(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<PowerShellResult> {
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }

  // -EncodedCommand (UTF-16LE base64) sidesteps every Windows command-line quoting pitfall —
  // the command reaches PowerShell byte-for-byte as the model wrote it.
  const encoded = Buffer.from(buildScript(command), "utf16le").toString("base64");
  const start = Date.now();
  const proc = Bun.spawn(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  const stdout = new CappedText();
  const stderr = new CappedText();
  let timedOut = false;
  let cancelled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    killTree(proc.pid);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await Promise.all([collect(proc.stdout, stdout), collect(proc.stderr, stderr), proc.exited]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  return {
    exit_code: timedOut || cancelled ? null : proc.exitCode,
    stdout: stdout.toString().trimEnd(),
    stderr: stderr.toString().trimEnd(),
    timed_out: timedOut,
    cancelled,
    truncated: stdout.truncated || stderr.truncated,
    duration_ms: Date.now() - start,
    cwd: options.cwd,
  };
}
