import { globalShortcut } from "electron";

/**
 * L1 (AGENTS.md section 9): registers ONE system-wide accelerator and does nothing else while
 * idle. Electron's globalShortcut only reports key-down (there is no key-up callback), which
 * is why the voice trigger is toggle-to-talk rather than hold-to-talk — see
 * prompts/stage-4-voice-hotkey-trigger.md decision 1.
 */
export class GlobalHotkey {
  private accelerator: string | null = null;

  /** Returns an error string when the combo can't be registered (invalid, or held by another app). */
  register(accelerator: string, onTrigger: () => void): string | null {
    this.unregister();
    try {
      if (!globalShortcut.register(accelerator, onTrigger)) {
        return `"${accelerator}" is already in use by another application; change voiceHotkey in config.json`;
      }
    } catch (error) {
      return `"${accelerator}" is not a valid accelerator: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.accelerator = accelerator;
    return null;
  }

  unregister(): void {
    if (this.accelerator) globalShortcut.unregister(this.accelerator);
    this.accelerator = null;
  }
}

/** Preflight probe: registers then immediately releases the combo to prove it is free. */
export function probeHotkey(accelerator: string): { passed: boolean; detail: string } {
  try {
    if (globalShortcut.isRegistered(accelerator)) return { passed: true, detail: `${accelerator} (already registered by this app)` };
    if (!globalShortcut.register(accelerator, () => {})) {
      return { passed: false, detail: `${accelerator} is held by another application; change voiceHotkey in config.json` };
    }
    globalShortcut.unregister(accelerator);
    return { passed: true, detail: `${accelerator} is free` };
  } catch (error) {
    return { passed: false, detail: `${accelerator} is not a valid accelerator: ${error instanceof Error ? error.message : String(error)}` };
  }
}
