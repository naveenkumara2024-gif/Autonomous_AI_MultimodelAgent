import type { EnvironmentFacts } from "./prompts/shared";

/**
 * Pluggable subagent definitions (AGENTS.md section 7 `SubagentDef`). The supervisor graph is
 * built from whatever is registered here — adding a subagent (clipboard, printer, a second
 * browser, one wrapping another MCP server) is a registerSubagent() call, with no change to
 * dispatch, routing, or concurrency logic. Resource needs are NOT declared here: they depend
 * on each call's args and are resolved per call (tools/resource-resolvers.ts).
 */
export interface SubagentDef {
  /** Graph node name and the value the supervisor dispatches to. */
  name: string;
  /** Shown to the supervisor to route work. */
  description: string;
  /** Selects this subagent's tools from the MCP server's tool list, by name. */
  selectTools: (toolName: string) => boolean;
  systemPrompt: (facts: EnvironmentFacts, maxSteps: number) => string;
}

const registry = new Map<string, SubagentDef>();

export function registerSubagent(def: SubagentDef): void {
  if (registry.has(def.name)) throw new Error(`subagent-registry: "${def.name}" is already registered`);
  if (!/^[a-z][a-z0-9-]*$/.test(def.name) || def.name === "supervisor") throw new Error(`subagent-registry: invalid name "${def.name}"`);
  registry.set(def.name, def);
}

export function listSubagents(): SubagentDef[] {
  return [...registry.values()];
}
