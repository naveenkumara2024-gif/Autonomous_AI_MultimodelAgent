import type { Recipe, RecipeStep } from "../memory/action-cache";
import type { ToolCallOutcome } from "../tools/tool-executor";
import type { FastPathContext } from "./fast-paths/registry";

/**
 * Replays a cached recipe (memory/action-cache.ts) through the turn's ToolExecutor — so each
 * step is risk-classified, approval-gated, locked and traced exactly like a live one — and
 * verifies as it goes. Stops at the first step that doesn't check out; the caller then hands
 * the turn to the live agent with a note of what already ran.
 */

export type ReplayResult =
  | { ok: true; steps: number; ms: number }
  | { ok: false; completed: string[]; failedStep: string; reason: string };

const ACTOR = "action-cache";

function parse(outcome: ToolCallOutcome): Record<string, unknown> | null {
  try {
    const v = JSON.parse(outcome.text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describe(step: RecipeStep): string {
  return step.intent || (step.kind === "verify" ? "find_element" : step.tool);
}

export async function replayRecipe(recipe: Recipe, ctx: FastPathContext): Promise<ReplayResult> {
  const started = Date.now();
  const completed: string[] = [];
  const run = (tool: string, args: Record<string, unknown>, intent: string) =>
    ctx.executor.execute({ tool, rawArgs: { ...args, intent: `${intent} (replay)` }, reasoningTrace: "", subagent: ACTOR, parentTraceId: null });
  const fail = (step: RecipeStep, reason: string): ReplayResult => ({ ok: false, completed, failedStep: describe(step), reason });

  for (const step of recipe.steps) {
    if (ctx.signal.aborted) return fail(step, "the user stopped the turn");

    if (step.kind === "verify" || step.kind === "anchored") {
      const lookupArgs = step.kind === "verify" ? step.args : step.anchor;
      const found = await run("find_element", lookupArgs, step.kind === "verify" ? step.intent : `Locate the target of: ${step.intent}`);
      const r = parse(found);
      const center = r?.found === true ? (r.center as { x?: number; y?: number } | undefined) : undefined;
      if (found.status !== "ok" || typeof center?.x !== "number" || typeof center?.y !== "number") {
        return fail(step, `the element it needs (${JSON.stringify(lookupArgs)}) wasn't found on screen this time`);
      }
      if (step.kind === "anchored") {
        const acted = await run(step.tool, { ...step.args, x: center.x, y: center.y, coordinate_type: "screen" }, step.intent);
        if (acted.status !== "ok") return fail(step, `${step.tool} ${acted.status}: ${acted.text.slice(0, 200)}`);
      }
      completed.push(describe(step));
      continue;
    }

    const out = await run(step.tool, step.args, step.intent);
    if (out.status !== "ok") return fail(step, `${step.tool} ${out.status}: ${out.text.slice(0, 200)}`);
    if (step.tool === "launch_app" && !parse(out)?.action) return fail(step, `launch_app couldn't find the app this time: ${out.text.slice(0, 200)}`);
    completed.push(describe(step));
  }

  return { ok: true, steps: recipe.steps.length, ms: Date.now() - started };
}
