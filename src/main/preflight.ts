export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/**
 * Startup checks: WSL2/Lima present, API keys set, hotkey free.
 * Stage 0: no checks are implemented yet — each is added by the stage that
 * builds the thing it verifies (sandbox, config, perception). Must never
 * report a check as passed that it did not actually run.
 */
export async function runPreflight(): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  return { ok: checks.every((c) => c.passed), checks };
}
