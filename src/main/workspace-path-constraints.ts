/**
 * Basic path-guard sandbox fallback (no VM required).
 * Stage 0: shape only. Real logic lands with tools/tool-executor.ts (Stage 3),
 * the first actual caller — throwing here instead of no-op'ing means an
 * accidental early caller fails loudly rather than silently passing.
 */
export function assertPathAllowed(_workspaceRoot: string, _targetPath: string): void {
  throw new Error("workspace-path-constraints: not implemented until Stage 3 (tool-executor)");
}
