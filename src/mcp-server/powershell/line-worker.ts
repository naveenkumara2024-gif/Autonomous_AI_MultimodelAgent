import { writeFile } from "node:fs/promises";
import { withTimeout } from "../core/async";

// --- Persistent PowerShell "worker" processes ---
//
// find_element and the system-control (volume/brightness) tools shell out to PowerShell for
// APIs bun:ffi can't reach directly (UI Automation, COM). Spawning a fresh powershell.exe per
// call pays for CLR startup and assembly load (and, for system-control, compiling embedded C#
// COM interop) every time — typically 300ms-2s of overhead before any real work. A worker keeps
// one PowerShell process alive: the script runs its setup once, then loops reading one JSON
// line from stdin and writing one JSON line of response per request.
//
// Requests are serialized through `queue` since stdin/stdout is one shared pipe — concurrent
// writes would interleave and desync request/response ordering. Any failure (timeout,
// unparseable output, unexpected exit) kills the process so the next request spawns a clean
// one rather than reading a stream that's now out of sync.

class LineReader {
  private iterator: AsyncIterator<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async nextLine(): Promise<string | null> {
    while (true) {
      const nlIndex = this.buffer.indexOf("\n");
      if (nlIndex !== -1) {
        const line = this.buffer.slice(0, nlIndex).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nlIndex + 1);
        return line;
      }
      const { value, done } = await this.iterator.next();
      if (done) {
        const rest = this.buffer;
        this.buffer = "";
        return rest.length > 0 ? rest : null;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

export class PsLineWorker {
  private proc: Bun.PipedSubprocess | null = null;
  private reader: LineReader | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly scriptPath: string,
    private readonly scriptContent: string,
  ) {}

  private async ensureAlive(): Promise<void> {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    await writeFile(this.scriptPath, this.scriptContent, "utf-8");
    this.proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    this.reader = new LineReader(this.proc.stdout as AsyncIterable<Uint8Array>);
    // Drain stderr in the background so a full pipe buffer can never stall the worker; any
    // PowerShell-side error surfaces instead as a bad/missing stdout line, which kill()s it.
    new Response(this.proc.stderr as ReadableStream<Uint8Array>).text().catch(() => {});
  }

  private kill(): void {
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this.reader = null;
  }

  async request<T>(payload: unknown, timeoutMs = 15000): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureAlive();
      const proc = this.proc!;
      const reader = this.reader!;
      try {
        proc.stdin.write(`${JSON.stringify(payload)}\n`);
        proc.stdin.flush();
        const line = await withTimeout(reader.nextLine(), timeoutMs, `PowerShell worker timed out after ${timeoutMs}ms.`);
        if (line === null) throw new Error("PowerShell worker exited unexpectedly.");
        return JSON.parse(line) as T;
      } catch (error) {
        this.kill();
        throw error;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
