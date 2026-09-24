import { registerSubagent } from "../subagent-registry";
import { browserSubagent } from "./browser-subagent";
import { desktopSubagent } from "./desktop-subagent";
import { shellSubagent } from "./shell-subagent";

let registered = false;

/** Registers the built-in subagents once (idempotent). */
export function registerBuiltInSubagents(): void {
  if (registered) return;
  registered = true;
  registerSubagent(desktopSubagent);
  registerSubagent(browserSubagent);
  registerSubagent(shellSubagent);
}
