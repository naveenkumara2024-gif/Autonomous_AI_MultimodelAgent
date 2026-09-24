import { shellSystemPrompt } from "../prompts/shell";
import type { SubagentDef } from "../subagent-registry";

// AGENTS.md section 5 also names a code-subagent for file read/write; file operations run
// through PowerShell here. A dedicated file-tool subagent can be registered later without
// touching dispatch.
export const shellSubagent: SubagentDef = {
  name: "shell",
  description:
    "Runs Windows PowerShell commands: finds, reads, creates, moves and deletes files and folders; inspects system information, disks, processes and services; launches installed apps by name.",
  selectTools: (name) => name === "run_powershell",
  systemPrompt: shellSystemPrompt,
};
