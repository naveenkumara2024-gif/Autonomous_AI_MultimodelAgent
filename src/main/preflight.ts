import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { McpServerCommand } from "./mcp/mcp-client";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

function mcpServerCheck(server: McpServerCommand): PreflightCheck {
  if (server.command.toLowerCase().endsWith(".exe")) {
    const passed = existsSync(server.command);
    return { name: "mcp-server", passed, detail: passed ? server.command : `missing ${server.command} (run \`bun run build:mcp\` before packaging)` };
  }
  const probe = spawnSync(server.command, ["--version"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  const passed = probe.status === 0;
  return {
    name: "mcp-server",
    passed,
    detail: passed ? `${server.command} ${probe.stdout.trim()}` : `"${server.command}" not found on PATH — the automation server can't start (install Bun: https://bun.sh)`,
  };
}

/** Whether the configured whisper model is on disk (the app downloads it on first run if not). */
export function voiceModelCheck(model: string): PreflightCheck {
  const present = existsSync(model) && statSync(model).size > 0;
  return {
    name: "voice-model",
    passed: present,
    detail: present ? model : `missing ${model} (the app downloads it on first run, or run \`bun run setup:voice\`)`,
  };
}

function chromeCheck(): PreflightCheck {
  // The browser tools launch Chrome through its App Paths registration (what makes Win+R
  // "chrome" work), so that's the thing to verify.
  for (const hive of ["HKLM", "HKCU"]) {
    const probe = spawnSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, "/ve"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const match = probe.status === 0 ? /REG_SZ\s+(.+)/.exec(probe.stdout) : null;
    if (match?.[1]) return { name: "chrome", passed: true, detail: match[1].trim() };
  }
  return { name: "chrome", passed: false, detail: "Google Chrome is not registered; browser automation tools will fail" };
}

/**
 * Startup checks. Each check reports what it actually verified — never a pass it didn't run.
 * Failures are logged, not fatal: the app still opens, and the affected feature reports its
 * own clear error when used.
 */
export async function runPreflight(options: { mcpServer: McpServerCommand; extraChecks?: PreflightCheck[] }): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [
    mcpServerCheck(options.mcpServer),
    {
      name: "agent-api-key",
      passed: Boolean(process.env.AGENT_BASE_URL && process.env.AGENT_API_KEY),
      detail: process.env.AGENT_API_KEY ? `endpoint ${process.env.AGENT_BASE_URL ?? "(AGENT_BASE_URL missing)"}` : "AGENT_API_KEY / AGENT_BASE_URL not set in .env",
    },
    chromeCheck(),
    ...(options.extraChecks ?? []),
  ];
  return { ok: checks.every((c) => c.passed), checks };
}
