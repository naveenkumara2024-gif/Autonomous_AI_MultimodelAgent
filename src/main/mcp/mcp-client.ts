import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type CallToolResult, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Owns the mcp-desktop server process (src/mcp-server) for the whole app: spawns it over
 * stdio, lists its tools, runs tool calls with timeouts + cancellation, and restarts it if it
 * dies. It's a single shared process, not one per session — it drives the one real desktop,
 * and cross-session safety is the resource lock manager's job, not process isolation.
 *
 * Nothing here decides whether a call is SAFE to make: callers go through
 * tools/tool-executor.ts, which runs the risk classifier / approval gate / locks first. The
 * only direct callers of callTool besides the executor are its read-only context lookups.
 */

export interface McpServerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpLogEntry {
  level: "debug" | "info" | "warning" | "error";
  source: "stderr" | "notification" | "client";
  message: string;
  data?: unknown;
}

export interface McpClientOptions {
  server: McpServerCommand;
  dataDir: string;
  onLog?: (entry: McpLogEntry) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const RECONNECT_BACKOFF_MS = [500, 2000, 5000];

// Secrets never cross into the automation process: it runs arbitrary PowerShell on the model's
// behalf, so anything in its environment is one `Get-ChildItem env:` away from a transcript.
const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function serverEnv(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV.test(key) || key === "ELECTRON_RUN_AS_NODE") continue;
    env[key] = value;
  }
  env.MCP_DATA_DIR = dataDir;
  return env;
}

export class McpClientManager {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private toolList: McpToolInfo[] = [];
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(private readonly options: McpClientOptions) {}

  get tools(): McpToolInfo[] {
    return this.toolList;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /** Idempotent: connects if not connected, otherwise returns immediately. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureConnected();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    await this.ensureConnected();
    const client = this.client!;
    const timeout = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return (await client.callTool({ name, arguments: args }, undefined, {
      signal: options.signal,
      timeout,
      maxTotalTimeout: timeout,
    })) as CallToolResult;
  }

  private log(entry: McpLogEntry): void {
    this.options.onLog?.(entry);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.stopped) throw new Error("MCP client is stopped.");
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const { server, dataDir } = this.options;
    for (let attempt = 0; ; attempt++) {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: serverEnv(dataDir),
          stderr: "pipe",
        });
        const client = new Client({ name: "autonomous-desktop-agent", version: "0.1.0" });

        client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
          const { level, data } = notification.params;
          this.log({ level: level === "warning" || level === "error" || level === "info" ? level : "debug", source: "notification", message: "tool log", data });
        });
        transport.onclose = () => {
          if (this.client === client) {
            this.client = null;
            if (!this.stopped) this.log({ level: "warning", source: "client", message: "MCP server exited; it will be restarted on the next tool call." });
          }
        };

        await client.connect(transport);
        transport.stderr?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
            if (line.trim()) this.log({ level: "debug", source: "stderr", message: line });
          }
        });

        await client.setLoggingLevel("info").catch(() => {});
        const { tools } = await client.listTools();
        this.toolList = tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> }));
        this.client = client;
        this.consecutiveFailures = 0;
        this.log({ level: "info", source: "client", message: `connected to mcp-desktop — ${this.toolList.length} tools` });
        return;
      } catch (error) {
        this.consecutiveFailures++;
        const message = error instanceof Error ? error.message : String(error);
        this.log({ level: "error", source: "client", message: `MCP connect attempt ${attempt + 1} failed: ${message}` });
        const delay = RECONNECT_BACKOFF_MS[attempt];
        if (delay === undefined || this.stopped) {
          throw new Error(`Could not start the MCP automation server (${server.command} ${server.args.join(" ")}): ${message}`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
