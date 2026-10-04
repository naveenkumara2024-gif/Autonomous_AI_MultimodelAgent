import type { DatabaseSync } from "node:sqlite";
import type { ExecutedCall } from "../tools/tool-executor";

/**
 * Task-recipe cache (prompts/stage-6, design C2). After a turn completes, the state-changing
 * calls that achieved it are stored as a recipe keyed by the exact (normalized) request. The
 * next time the same request arrives it's replayed step by step — every step still through
 * the ToolExecutor (classifier → approval → lock → trace), every step verified — instead of
 * re-planning with the model. Any mismatch aborts the replay and the live agent takes over.
 *
 * What makes a recipe safe to replay is decided HERE, conservatively:
 *   - clicks must be ANCHORED: their coordinates came from a find_element result, so replay
 *     re-runs that lookup and clicks the element's CURRENT position. A click whose position
 *     came from a screenshot (vision) can't be re-verified, so the whole turn isn't cached.
 *   - only action/verification tools: a turn that read data (a shell command, page text) had
 *     an answer that depended on it, and replaying the clicks wouldn't reproduce the answer.
 *   - nothing denied, nothing failed, no typing into a password/payment field (so a recipe
 *     never stores a secret), no browser tab ids (they don't survive a restart).
 */

export type RecipeStep =
  | { kind: "call"; tool: string; args: Record<string, unknown>; intent: string }
  /** find_element that found its element originally — replay must find it again. */
  | { kind: "verify"; args: Record<string, unknown>; intent: string }
  /** A pointer action at a find_element result's center — replay re-locates, then acts. */
  | { kind: "anchored"; tool: string; args: Record<string, unknown>; anchor: Record<string, unknown>; intent: string };

export interface Recipe {
  key: string;
  request: string;
  steps: RecipeStep[];
  successes: number;
  failures: number;
  avgMs: number | null;
}

/** Tools that change state and replay meaningfully. */
const ACTION_TOOLS = new Set([
  "launch_app", "click", "type_text", "key_press", "scroll", "move_mouse", "init_app", "set_volume", "set_brightness",
  "browser_navigate", "browser_click", "browser_type", "browser_new_tab", "browser_handle_dialog",
]);
/** Replayed as-is for timing/verification (a wait lets the UI settle; browser_wait_for checks it). */
const REPLAYED_CHECKS = new Set(["wait", "browser_wait_for", "browser_find"]);
/** Pure observation — dropped from the recipe (the replay verifies with find_element instead). */
const IGNORED = new Set([
  "screenshot_for_display", "get_displays", "get_mouse_position", "get_all_visited_apps", "get_click_history",
  "browser_connect", "browser_list_tabs", "browser_screenshot", "echo",
]);
/** Pointer tools whose x/y must be anchored to a find_element result. */
const POINTER_TOOLS = new Set(["click", "scroll", "move_mouse"]);

const MAX_STEPS = 40;
const SENSITIVE_CATEGORIES = new Set(["credential-entry", "payment"]);
// Requests whose meaning depends on the conversation ("do it again", "close that") must never
// be replayed in another context.
const CONTEXT_WORDS = /\b(it|that|this|these|those|them|again|same|previous|above|there|last one|the other)\b/i;

export function normalizeRequest(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?]+$/, "").trim();
}

/** The cache key for a request, or null when the request can't be cached at all. */
export function recipeKey(text: string): string | null {
  const key = normalizeRequest(text);
  if (key.split(" ").length < 3 || key.length > 300) return null;
  if (CONTEXT_WORDS.test(key)) return null;
  return key;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text.replace(/\n\[\d+ screenshot\(s\) withheld[\s\S]*$/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function centerOf(call: ExecutedCall): { x: number; y: number } | null {
  const r = parseJson(call.text);
  const c = r?.found === true ? (r.center as { x?: unknown; y?: unknown } | undefined) : undefined;
  return c && typeof c.x === "number" && typeof c.y === "number" ? { x: c.x, y: c.y } : null;
}

/** Builds a replayable recipe from a completed turn's calls, or null if it isn't safely replayable. */
export function buildRecipe(calls: ExecutedCall[]): RecipeStep[] | null {
  const steps: RecipeStep[] = [];
  // The most recent successful find_element per subagent (a click answers its own agent's lookup).
  const lastFound = new Map<string, { call: ExecutedCall; center: { x: number; y: number }; stepIndex: number }>();
  const consumed = new Set<number>();
  let actions = 0;

  for (const call of calls) {
    if (call.status === "denied" || call.status === "cancelled") return null;
    if (SENSITIVE_CATEGORIES.has(call.riskCategory ?? "")) return null;
    if (call.context.focusedElement?.is_password) return null;
    if (typeof call.args.tab_id === "string" && call.args.tab_id) return null;
    const stateChanging = call.resources.length > 0;

    if (call.tool === "find_element") {
      if (call.isError || call.args.focused || call.args.at_point) continue;
      const center = centerOf(call);
      if (!center) continue; // a miss while searching isn't part of the procedure
      steps.push({ kind: "verify", args: call.args, intent: call.intent });
      lastFound.set(call.subagent, { call, center, stepIndex: steps.length - 1 });
      continue;
    }
    if (IGNORED.has(call.tool) || (call.tool === "screenshot" && !call.args.output_path)) continue;

    if (call.isError) {
      if (stateChanging) return null; // a failed action means the turn's path isn't clean
      continue;
    }

    if (call.tool === "launch_app") {
      // Only an actual launch/switch is a step; a "not found" answer was the agent searching.
      if (!parseJson(call.text)?.action) continue;
    }

    if (POINTER_TOOLS.has(call.tool) && typeof call.args.x === "number" && typeof call.args.y === "number") {
      const found = lastFound.get(call.subagent);
      const anchored = found && Math.abs(found.center.x - call.args.x) <= 1 && Math.abs(found.center.y - call.args.y) <= 1;
      if (!anchored) return null; // vision-derived coordinates: can't be re-verified on replay
      // The lookup becomes the anchor of this action instead of a separate verify step.
      consumed.add(found.stepIndex);
      lastFound.delete(call.subagent);
      const { x: _x, y: _y, coordinate_type: _c, ...rest } = call.args;
      steps.push({ kind: "anchored", tool: call.tool, args: rest, anchor: found.call.args, intent: call.intent });
      actions++;
      continue;
    }

    if (ACTION_TOOLS.has(call.tool)) {
      steps.push({ kind: "call", tool: call.tool, args: call.args, intent: call.intent });
      if (call.tool !== "init_app") actions++;
      continue;
    }
    if (REPLAYED_CHECKS.has(call.tool)) {
      steps.push({ kind: "call", tool: call.tool, args: call.args, intent: call.intent });
      continue;
    }
    // Anything else (run_powershell, page-text extraction, file uploads, MCP extras, …) read or
    // changed something a replay can't stand in for.
    return null;
  }

  const recipe = steps.filter((_, i) => !consumed.has(i));
  if (actions === 0 || recipe.length > MAX_STEPS) return null;
  return recipe;
}

interface RecipeRow {
  key: string;
  request: string;
  steps: string;
  successes: number;
  failures: number;
  avg_ms: number | null;
}

/** Consecutive failed replays after which a recipe is dropped. */
const MAX_CONSECUTIVE_FAILURES = 2;

export class ActionCache {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_recipes (
        key TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        steps TEXT NOT NULL,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        avg_ms INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      )
    `);
  }

  get(key: string): Recipe | null {
    const row = this.db.prepare(`SELECT key, request, steps, successes, failures, avg_ms FROM action_recipes WHERE key = ?`).get(key) as RecipeRow | undefined;
    if (!row) return null;
    try {
      return { key: row.key, request: row.request, steps: JSON.parse(row.steps), successes: row.successes, failures: row.failures, avgMs: row.avg_ms };
    } catch {
      this.delete(key);
      return null;
    }
  }

  /** Stores (or replaces) the recipe for a request that just completed. */
  save(key: string, request: string, steps: RecipeStep[]): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO action_recipes (key, request, steps, successes, failures, avg_ms, created_at, last_used_at)
         VALUES (?, ?, ?, 0, 0, NULL, ?, ?)
         ON CONFLICT(key) DO UPDATE SET request = excluded.request, steps = excluded.steps, failures = 0, last_used_at = excluded.last_used_at`,
      )
      .run(key, request, JSON.stringify(steps), now, now);
  }

  markSuccess(key: string, ms: number): void {
    this.db
      .prepare(
        `UPDATE action_recipes SET successes = successes + 1, failures = 0, last_used_at = ?,
           avg_ms = CASE WHEN avg_ms IS NULL THEN ? ELSE (avg_ms * successes + ?) / (successes + 1) END
         WHERE key = ?`,
      )
      .run(Date.now(), ms, ms, key);
  }

  /** Records a failed replay; evicts the recipe after repeated failures. Returns true if evicted. */
  markFailure(key: string): boolean {
    this.db.prepare(`UPDATE action_recipes SET failures = failures + 1, last_used_at = ? WHERE key = ?`).run(Date.now(), key);
    const row = this.db.prepare(`SELECT failures FROM action_recipes WHERE key = ?`).get(key) as { failures: number } | undefined;
    if (row && row.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.delete(key);
      return true;
    }
    return false;
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM action_recipes WHERE key = ?`).run(key);
  }

  clear(): void {
    this.db.exec(`DELETE FROM action_recipes`);
  }
}
