import * as z from "zod";
import type { DefineTool } from "../core/define-tool";
import { fail, json, text } from "../core/result";
import { activeTab, cdpEvaluate, cdpSend } from "../browser/cdp-client";
import {
  clearHighlightsScript,
  elementRectScript,
  extractHighlightedScript,
  maskPasswordsScript,
  unmaskPasswordsScript,
} from "../browser/page-scripts";

const SCOPE = "Browser automation tool — current tab of the automation Chrome via CDP only.";

export function registerBrowserPageTools(defineTool: DefineTool): void {
  defineTool(
    "browser_extract_highlighted",
    {
      description: `${SCOPE} Extract text AND visibly mark where it came from: locates content by CSS selector OR a plain-text query (the smallest element containing that substring, widened to its nearest paragraph/list-item/heading/cell so the extract has full sentence context), scrolls it into view, outlines and tints it on the real page (plus an optional label badge), then returns its text. Use this instead of browser_get_text whenever extracted text will be quoted or cited, so a screenshot shows exactly which part of the site it came from. Highlights persist (pass clear_previous: false to keep several visible) until browser_clear_highlights.`,
      inputSchema: {
        selector: z.string().optional().describe("CSS selector of the element to highlight and extract. Provide this OR query, not both."),
        query: z
          .string()
          .optional()
          .describe("Plain-text substring to search for in the page's visible text (case-insensitive). Provide this OR selector, not both."),
        index: z.number().default(0).describe("Which match to use if selector matches multiple elements. Ignored for query. Default: 0"),
        label: z.string().optional().describe('Short badge text placed above the highlight (e.g. "Source 1"). Omit for no badge.'),
        color: z.string().default("#ffd60a").describe("Highlight color as a hex string, e.g. #ffd60a."),
        clear_previous: z.boolean().default(true).describe("Remove earlier highlights first. Pass false to keep multiple highlights visible at once."),
        max_length: z.number().default(20000).describe("Truncate the returned text at this many characters. Default: 20000"),
      },
    },
    async ({ selector, query, index, label, color, clear_previous, max_length }) => {
      if (!selector && !query) return fail("Provide either selector or query.");
      const { session } = await activeTab({ requireNoDialog: true });
      const value = await cdpEvaluate(
        session.sessionId,
        extractHighlightedScript({ selector, query, index, label, color, clearPrevious: clear_previous, maxLength: max_length }),
      );
      if (!value?.found) {
        return fail(selector ? `No element matched selector "${selector}".` : `No element on the page contains the text "${query}".`);
      }
      return json({ ...value, source_url: session.url, source_title: session.title });
    },
  );

  defineTool(
    "browser_clear_highlights",
    {
      description: `${SCOPE} Remove all highlights added by browser_extract_highlighted on the current page (restores original inline styles, removes badges).`,
      inputSchema: {},
    },
    async () => {
      const { session } = await activeTab();
      const count = await cdpEvaluate(session.sessionId, clearHighlightsScript);
      return text(`Cleared ${count} highlight(s).`);
    },
  );

  defineTool(
    "browser_screenshot",
    {
      description: `${SCOPE} Screenshot of the current tab's rendered page (viewport, full page, or one element) returned as a PNG image — not the OS screen (use screenshot_for_display for that). Password fields are blacked out before capture.`,
      inputSchema: {
        full_page: z.boolean().default(false).describe("Capture the full scrollable page instead of just the viewport."),
        selector: z.string().optional().describe("Capture only this element's bounding box."),
      },
    },
    async ({ full_page, selector }) => {
      const { session } = await activeTab();

      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (selector) {
        const rect = await cdpEvaluate(session.sessionId, elementRectScript(selector));
        if (!rect) return fail(`No element matched selector "${selector}".`);
        clip = { ...rect, scale: 1 };
      }

      const masked = (await cdpEvaluate(session.sessionId, maskPasswordsScript)) as number;
      let data: string;
      try {
        const result = (await cdpSend(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: full_page, ...(clip ? { clip } : {}) },
          session.sessionId,
        )) as { data: string };
        data = result.data;
      } finally {
        await cdpEvaluate(session.sessionId, unmaskPasswordsScript).catch(() => {});
      }

      const redaction = { method: "dom-password-fields", scope: "page", masked, complete: true };
      return {
        content: [
          { type: "image" as const, data, mimeType: "image/png", _meta: { redaction } },
          { type: "text" as const, text: JSON.stringify({ url: session.url, title: session.title, redaction }, null, 2) },
        ],
      };
    },
  );

  defineTool(
    "browser_evaluate",
    {
      description: `${SCOPE} Run arbitrary JavaScript in the current page and return its (JSON-serializable) value. Escape hatch for anything the other browser_* tools don't cover. Powerful: this executes real code in the page context, and requires the user's approval.`,
      inputSchema: {
        expression: z.string().describe("JavaScript expression to evaluate. May be an async IIFE; awaited automatically."),
      },
    },
    async ({ expression }) => {
      const { session } = await activeTab();
      const value = await cdpEvaluate(session.sessionId, expression, true);
      return json(value ?? null);
    },
  );
}
