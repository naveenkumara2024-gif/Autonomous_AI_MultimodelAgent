import { openAppFastPath } from "./open-app";
import { registerFastPath } from "./registry";

/** Registers the built-in fast paths (mirrors subagents/index.ts). Idempotent. */
export function registerBuiltInFastPaths(): void {
  registerFastPath(openAppFastPath);
}

export { runFastPaths } from "./registry";
