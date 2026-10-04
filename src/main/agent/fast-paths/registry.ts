import type { ToolExecutor } from "../../tools/tool-executor";
import type { TurnOutcome } from "../agent-runner";
import type { TurnTrace } from "../trace";

/**
 * Deterministic shortcuts for request shapes with exactly one obviously-correct action
 * (prompts/stage-5 + stage-6). Checked before the supervisor graph runs. A fast path is a
 * ROUTING shortcut, never a safety one: every call it makes goes through the turn's
 * ToolExecutor (risk classifier → approval → resource lock → trace), exactly like an
 * agent-dispatched call. Returning null from `match` or `run` hands the turn to the normal
 * agent, so an imperfect matcher only ever costs time, never correctness.
 *
 * Mirrors subagent-registry.ts: adding a fast path is a new file + one register call.
 */

export interface FastPathContext {
  executor: ToolExecutor;
  trace: TurnTrace;
  signal: AbortSignal;
}

export interface FastPath<M = unknown> {
  name: string;
  match(text: string): M | null;
  run(match: M, ctx: FastPathContext): Promise<TurnOutcome | null>;
}

const registry: Array<FastPath<unknown>> = [];

export function registerFastPath<M>(fastPath: FastPath<M>): void {
  if (registry.some((f) => f.name === fastPath.name)) return;
  registry.push(fastPath as FastPath<unknown>);
}

export function listFastPaths(): ReadonlyArray<FastPath<unknown>> {
  return registry;
}

/** First fast path that matches AND completes wins; null = run the normal agent. */
export async function runFastPaths(text: string, ctx: FastPathContext): Promise<{ name: string; outcome: TurnOutcome } | null> {
  for (const fastPath of registry) {
    const match = fastPath.match(text);
    if (match === null) continue;
    ctx.trace.emit("shortcut", "system", { kind: "fast-path", name: fastPath.name, result: "matched" });
    const outcome = await fastPath.run(match, ctx);
    if (outcome) return { name: fastPath.name, outcome };
    ctx.trace.emit("shortcut", "system", { kind: "fast-path", name: fastPath.name, result: "fell-through", text: "Handing the request to the agent." });
  }
  return null;
}
