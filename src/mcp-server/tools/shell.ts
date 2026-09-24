import { homedir } from "node:os";
import * as z from "zod";
import type { DefineTool } from "../core/define-tool";
import { json } from "../core/result";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runPowerShell } from "../powershell/run-command";

export function registerShellTools(defineTool: DefineTool): void {
  defineTool(
    "run_powershell",
    {
      description:
        "Run a Windows PowerShell 5.1 command on this machine and return its stdout, stderr, and exit code. Each call runs in a FRESH powershell.exe (no variables, working directory, or modules carry over between calls) — pass `cwd` explicitly and chain dependent steps within one command. Output is UTF-8 and capped at ~30k characters per stream (the middle is omitted). The process tree is killed on timeout. Non-interactive: commands that prompt for input will fail or hang until the timeout, so pass -Confirm:$false / -Force where appropriate. Prefer read-only inspection (Get-ChildItem, Get-Content, Test-Path, Get-Process) before anything that changes state.",
      inputSchema: {
        command: z.string().min(1).describe("PowerShell command or script to run. Multi-line scripts are fine."),
        cwd: z.string().optional().describe("Working directory (absolute path). Defaults to the user's home folder."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .default(DEFAULT_TIMEOUT_MS)
          .describe(`Kill the command after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
      },
    },
    async ({ command, cwd, timeout_ms }, { signal }) => {
      const result = await runPowerShell(command, { cwd: cwd ?? homedir(), timeoutMs: timeout_ms, signal });
      const failed = result.timed_out || result.cancelled || result.exit_code !== 0;
      return { ...json(result), ...(failed ? { isError: true } : {}) };
    },
  );
}
