import * as z from "zod";
import { sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { fail, json, text } from "../core/result";
import { activeTab, cdpEvaluate, cdpSend } from "../browser/cdp-client";
import { clickScript, existsScript, findScript, getTextScript, typeScript } from "../browser/page-scripts";

const SCOPE = "Browser automation tool — DOM-based via CDP, current tab of the automation Chrome only; no access to other applications or OS-level UI.";
const noMatch = (selector: string | undefined) => `No element matched selector "${selector}".`;

export function registerBrowserDomTools(defineTool: DefineTool): void {
  defineTool(
    "browser_find",
    {
      description: `${SCOPE} Find element(s) matching a CSS selector via the DOM (not vision) — returns tag, text, id, class, attributes, bounding rect, and visibility. The web-page analogue of find_element; prefer it over a screenshot whenever you can express a selector.`,
      inputSchema: {
        selector: z.string().describe("CSS selector to search for."),
        all: z.boolean().default(false).describe("Return all matches (capped at 50) instead of just the first."),
      },
    },
    async ({ selector, all }) => {
      const { session } = await activeTab();
      return json(await cdpEvaluate(session.sessionId, findScript(selector, all)));
    },
  );

  defineTool(
    "browser_click",
    {
      description: `${SCOPE} Click an element matched by a CSS selector (scrolls it into view first). A DOM click, not a coordinate click — use this instead of the desktop click tool for anything inside the page.`,
      inputSchema: {
        selector: z.string().describe("CSS selector of the element to click."),
        index: z.number().default(0).describe("Which match to click if the selector matches multiple elements. Default: 0"),
      },
    },
    async ({ selector, index }) => {
      const { session } = await activeTab({ requireNoDialog: true });
      const value = await cdpEvaluate(session.sessionId, clickScript(selector, index));
      if (!value?.found) return fail(noMatch(selector));
      return text(`Clicked <${value.tag}> matching "${selector}": "${value.text}"`);
    },
  );

  defineTool(
    "browser_type",
    {
      description: `${SCOPE} Type text into an element matched by a CSS selector: input/textarea (via the native value setter, so React/Vue-controlled inputs pick it up) or a contenteditable element. Replaces the current value. If press_enter and the element belongs to a <form>, submits the form directly (more reliable than a synthetic Enter).`,
      inputSchema: {
        selector: z.string().describe("CSS selector of the element to type into."),
        text: z.string().describe("Text to type."),
        press_enter: z.boolean().default(false).describe("Submit the form (or send a synthetic Enter) after typing. Default: false"),
        index: z.number().default(0).describe("Which match to use if the selector matches multiple elements. Default: 0"),
      },
    },
    async ({ selector, text: value, press_enter, index }) => {
      const { session } = await activeTab({ requireNoDialog: true });
      const result = await cdpEvaluate(session.sessionId, typeScript(selector, value, press_enter, index));
      if (!result?.found) return fail(noMatch(selector));
      if (!result.typed) return fail(result.reason);
      return text(`Typed into "${selector}"${result.submitted ? " and submitted its form" : ""}.`);
    },
  );

  defineTool(
    "browser_get_text",
    {
      description: `${SCOPE} Read the visible text (innerText) of an element, or the whole page body if no selector is given.`,
      inputSchema: {
        selector: z.string().optional().describe("CSS selector. Omit to read the whole page body."),
        max_length: z.number().default(20000).describe("Truncate the returned text at this many characters. Default: 20000"),
      },
    },
    async ({ selector, max_length }) => {
      const { session } = await activeTab();
      const value = await cdpEvaluate(session.sessionId, getTextScript(selector, max_length));
      if (!value?.found) return fail(noMatch(selector));
      return json(value);
    },
  );

  defineTool(
    "browser_wait_for",
    {
      description: `${SCOPE} Wait until an element matching a CSS selector appears in the DOM, polling every 150ms.`,
      inputSchema: {
        selector: z.string().describe("CSS selector to wait for."),
        timeout_ms: z.number().default(10000).describe("Max time to wait. Default: 10000"),
      },
    },
    async ({ selector, timeout_ms }, { signal }) => {
      const { session } = await activeTab();
      const deadline = Date.now() + timeout_ms;
      while (Date.now() < deadline && !signal.aborted) {
        if (await cdpEvaluate(session.sessionId, existsScript(selector))) return text(`Found "${selector}".`);
        await sleep(150);
      }
      return fail(`Timed out waiting for "${selector}" after ${timeout_ms}ms.`);
    },
  );

  defineTool(
    "browser_set_file_input",
    {
      description: `${SCOPE} Set file(s) on an <input type="file"> matched by a CSS selector, directly — the OS file picker never opens. Note this uploads local files to the website once the form is submitted.`,
      inputSchema: {
        selector: z.string().describe("CSS selector of the file input."),
        file_paths: z.array(z.string()).min(1).describe("Absolute local file path(s) to attach."),
      },
    },
    async ({ selector, file_paths }) => {
      const { session } = await activeTab();
      const doc = (await cdpSend("DOM.getDocument", { depth: -1, pierce: true }, session.sessionId)) as { root: { nodeId: number } };
      const query = (await cdpSend("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, session.sessionId)) as { nodeId: number };
      if (!query.nodeId) return fail(noMatch(selector));
      await cdpSend("DOM.setFileInputFiles", { files: file_paths, nodeId: query.nodeId }, session.sessionId);
      return text(`Set ${file_paths.length} file(s) on "${selector}".`);
    },
  );

  defineTool(
    "browser_handle_dialog",
    {
      description: `${SCOPE} Respond to a JS dialog (alert/confirm/prompt/beforeunload) open on the current tab. Other browser_* tools error out with the dialog's message while one is blocking the page. Cannot handle native OS dialogs (file pickers, credential prompts) — those need the desktop tools.`,
      inputSchema: {
        accept: z.boolean().describe("true to accept/OK the dialog, false to dismiss/cancel it."),
        prompt_text: z.string().optional().describe("Text to enter if the dialog is a prompt()."),
      },
    },
    async ({ accept, prompt_text }) => {
      const { state, session } = await activeTab();
      const dialog = state.pendingDialogs.get(session.sessionId);
      if (!dialog) return fail("No dialog is currently open on this tab.");
      await cdpSend("Page.handleJavaScriptDialog", { accept, promptText: prompt_text }, session.sessionId);
      state.pendingDialogs.delete(session.sessionId);
      return text(`${accept ? "Accepted" : "Dismissed"} ${dialog.type} dialog: "${dialog.message}"`);
    },
  );
}
