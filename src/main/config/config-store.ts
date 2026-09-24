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
  /**
   * Whether screenshots may be sent to the agent model at all (after password-field masking,
   * perception/redactor.ts). false = vision off; the agent relies on UI Automation / DOM only.
   */
  allowScreenshotsToModel: boolean;
}

// Stage 1 wrote this placeholder into config.json and every session row; no code ever called
// it. Replaced once with the real agent model (prompts/stage-3-mcp-automation-agent.md).
export const LEGACY_PLACEHOLDER_MODEL = "claude-sonnet-5";

const DEFAULT_CONFIG: AgentConfig = {
  defaultModel: "agnes-3-flash",
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
  allowScreenshotsToModel: true,
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
    if (cached.defaultModel === LEGACY_PLACEHOLDER_MODEL || !("allowScreenshotsToModel" in parsed)) {
      if (cached.defaultModel === LEGACY_PLACEHOLDER_MODEL) cached.defaultModel = DEFAULT_CONFIG.defaultModel;
      writeFileSync(file, JSON.stringify(cached, null, 2), "utf-8");
    }
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
