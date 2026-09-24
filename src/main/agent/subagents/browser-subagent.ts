import { browserSystemPrompt } from "../prompts/browser";
import type { SubagentDef } from "../subagent-registry";

export const browserSubagent: SubagentDef = {
  name: "browser",
  description:
    "Operates websites in a dedicated automation Chrome via the DevTools Protocol: navigates, searches, reads and extracts page text with visible source highlighting, clicks and fills forms by CSS selector, handles tabs and dialogs. Returns research as cited claims.",
  selectTools: (name) => name.startsWith("browser_") || name === "wait",
  systemPrompt: browserSystemPrompt,
};
