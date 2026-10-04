import type { FastPath } from "./registry";

/**
 * "open / launch / start / switch to <app>" — and nothing else — resolves to one launch_app
 * call with zero model calls. The whole message must be exactly that request: anything with a
 * second clause ("open notepad and type hi"), a path, a URL, or more than a short app name is
 * left to the supervisor, which is what keeps an approval-free shortcut from firing on an
 * instruction buried inside longer text.
 */

const OPEN_REQUEST =
  /^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+|pls\s+|just\s+|quickly\s+)?(?:open(?:\s+up)?|launch|start(?:\s+up)?|run|bring\s+up|switch\s+to|show\s+me)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application))?(?:\s+(?:for\s+me|please|now))?\s*[.!?]*$/i;

// Multi-clause joins, and words that make the target something other than an installed app.
const DISQUALIFIERS = /\b(and|then|also|after|before|with|to|in|on|from|into|using|via|if|but|or)\b|[,;:\\/@]|\.\w/i;
const NOT_AN_APP = /^(a|an|some|new|this|that|it|file|folder|document|tab|website|page|link|url|timer|scan|search)\b/i;
const MAX_WORDS = 4;

export interface OpenAppMatch {
  appName: string;
}

export function matchOpenApp(text: string): OpenAppMatch | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80 || /\n/.test(trimmed)) return null;
  const m = OPEN_REQUEST.exec(trimmed);
  const appName = m?.[1]?.trim();
  if (!appName) return null;
  if (DISQUALIFIERS.test(appName) || NOT_AN_APP.test(appName)) return null;
  if (appName.split(/\s+/).length > MAX_WORDS) return null;
  return { appName };
}

interface LaunchResult {
  launched?: boolean;
  found?: boolean;
  action?: "launched" | "focused" | "none";
  confirmed?: boolean;
  display_name?: string;
  message?: string;
}

export const openAppFastPath: FastPath<OpenAppMatch> = {
  name: "open-app",
  match: matchOpenApp,
  async run({ appName }, { executor }) {
    const outcome = await executor.execute({
      tool: "launch_app",
      rawArgs: { app_name: appName, intent: `Open ${appName}` },
      reasoningTrace: "",
      subagent: "fast-path",
      parentTraceId: null,
    });
    if (outcome.status !== "ok") return null;
    let result: LaunchResult;
    try {
      result = JSON.parse(outcome.text) as LaunchResult;
    } catch {
      return null;
    }
    // Not found / ambiguous: let the agent ask or try another way.
    if (!result.action) return null;

    const name = result.display_name ?? appName;
    // An unconfirmed launch still ends here: falling through would let the agent start a
    // second copy of an app that is merely slow to show its window.
    const text =
      result.action === "none"
        ? `**${name}** is already open and in front.`
        : result.action === "focused"
          ? result.confirmed
            ? `Switched to **${name}** — it was already open.`
            : `**${name}** is already open; I asked Windows to bring it to the front, but couldn't confirm it's in front.`
          : result.confirmed
            ? `Opened **${name}**.`
            : `Started **${name}** — it's still loading (no window yet). I didn't start it a second time.`;
    return { status: result.confirmed ? "done" : "partial", text };
  },
};
