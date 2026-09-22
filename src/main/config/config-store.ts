import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface PermissionConfig {
  requireApprovalFor: string[];
}

export interface RetryPolicy {
  maxRetries: number;
  maxLoopIterations: number;
}

export interface ContextCompactionConfig {
  strategy: "summarize" | "truncate";
  threshold: number;
}

export interface AgentConfig {
  defaultModel: string;
  defaultPermissionHooks: PermissionConfig;
  defaultRetryPolicy: RetryPolicy;
  defaultContextCompaction: ContextCompactionConfig;
}

const DEFAULT_CONFIG: AgentConfig = {
  defaultModel: "claude-sonnet-5",
  defaultPermissionHooks: {
    requireApprovalFor: ["file-delete", "credential-entry", "payment", "network-egress", "mass-modify"],
  },
  defaultRetryPolicy: {
    maxRetries: 3,
    maxLoopIterations: 25,
  },
  defaultContextCompaction: {
    strategy: "summarize",
    threshold: 0.8,
  },
};

function configPath(): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "config.json");
}

let cached: AgentConfig | null = null;

export function loadConfig(): AgentConfig {
  if (cached) return cached;

  const file = configPath();
  if (!existsSync(file)) {
    cached = DEFAULT_CONFIG;
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return cached;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<AgentConfig>;
    cached = { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.error(`[config] failed to parse ${file}, falling back to defaults`, err);
    cached = DEFAULT_CONFIG;
  }
  return cached;
}

export function saveConfig(config: AgentConfig): void {
  cached = config;
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}
