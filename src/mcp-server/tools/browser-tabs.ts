import * as z from "zod";
import { sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { json, text } from "../core/result";
import {
  activeTab,
  attachAndPrepare,
  cdpSend,
  ensureBrowserConnected,
  getCurrentSession,
  listOpenTabs,
  refreshSessionInfo,
  waitForCdpEvent,
} from "../browser/cdp-client";

const SCOPE = "Browser automation tool — scoped to the dedicated automation Chrome via the DevTools Protocol (CDP); it cannot see or control other applications or OS-level UI.";

export function registerBrowserTabTools(defineTool: DefineTool): void {
  defineTool(
    "browser_connect",
    {
      description: `${SCOPE} Connects to a dedicated, persistent automation Chrome profile (separate from the user's regular Chrome, whose windows are never touched), auto-launching it with remote debugging if needed. Not required before other browser_* tools (they connect automatically), but useful to check connection state or trigger the launch deliberately. Chrome 136+ blocks remote debugging on the default profile, which is why a separate profile is used — the user may need to log in to sites once inside it.`,
      inputSchema: {},
    },
    async () => {
      const state = await ensureBrowserConnected();
      return json({ connected: true, tabs: await listOpenTabs(state) });
    },
  );

  defineTool(
    "browser_list_tabs",
    {
      description: `${SCOPE} List open tabs (id, url, title, and which one is current).`,
      inputSchema: {},
    },
    async () => {
      const state = await ensureBrowserConnected();
      return json({ tabs: await listOpenTabs(state) });
    },
  );

  defineTool(
    "browser_new_tab",
    {
      description: `${SCOPE} Opens a new tab and makes it the active tab for subsequent browser_* calls.`,
      inputSchema: {
        url: z.string().optional().describe('URL to open. Defaults to "about:blank".'),
      },
    },
    async ({ url }) => {
      await ensureBrowserConnected();
      const created = (await cdpSend("Target.createTarget", { url: url ?? "about:blank" })) as { targetId: string };
      const session = await attachAndPrepare(created.targetId);
      return json({ id: session.targetId, url: session.url });
    },
  );

  defineTool(
    "browser_activate_tab",
    {
      description: `${SCOPE} Switch the active tab (for subsequent browser_* calls) and bring it to the front.`,
      inputSchema: {
        tab_id: z.string().describe("Tab id, from browser_list_tabs."),
      },
    },
    async ({ tab_id }) => {
      const state = await ensureBrowserConnected();
      const session = [...state.sessions.values()].find((s) => s.targetId === tab_id) ?? (await attachAndPrepare(tab_id));
      state.currentSessionId = session.sessionId;
      await cdpSend("Target.activateTarget", { targetId: tab_id });
      return text(`Activated tab ${tab_id} (${session.url}).`);
    },
  );

  defineTool(
    "browser_close_tab",
    {
      description: `${SCOPE} Close a tab. Defaults to the current tab.`,
      inputSchema: {
        tab_id: z.string().optional().describe("Tab id to close. Defaults to the current tab."),
      },
    },
    async ({ tab_id }) => {
      const state = await ensureBrowserConnected();
      const targetId = tab_id ?? getCurrentSession(state).targetId;
      await cdpSend("Target.closeTarget", { targetId });
      for (const [sid, session] of state.sessions) {
        if (session.targetId !== targetId) continue;
        state.sessions.delete(sid);
        if (state.currentSessionId === sid) {
          const remaining = state.sessions.values().next().value;
          state.currentSessionId = remaining ? remaining.sessionId : null;
        }
      }
      return text(`Closed tab ${targetId}.`);
    },
  );

  defineTool(
    "browser_navigate",
    {
      description: `${SCOPE} Navigate the current tab to a URL and wait for it to finish loading. Returns the final URL and title (after any redirects).`,
      inputSchema: {
        url: z.string().describe("URL to navigate to."),
        wait_until: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .default("load")
          .describe('When to consider navigation complete. "networkidle" waits for no in-flight network requests for 500ms.'),
        timeout_ms: z.number().default(30000).describe("Max time to wait for the load condition. Default: 30000"),
      },
    },
    async ({ url, wait_until, timeout_ms }) => {
      const { state, session } = await activeTab({ requireNoDialog: true });

      const eventName = wait_until === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
      const waitPromise = wait_until === "networkidle" ? null : waitForCdpEvent(eventName, session.sessionId, timeout_ms);

      const navResult = (await cdpSend("Page.navigate", { url }, session.sessionId)) as { errorText?: string };
      if (navResult.errorText) throw new Error(`Navigation failed: ${navResult.errorText}`);

      if (waitPromise) {
        await waitPromise;
      } else {
        const deadline = Date.now() + timeout_ms;
        let idleSince: number | null = null;
        while (Date.now() < deadline) {
          const inFlight = state.inFlightRequests.get(session.sessionId)?.size ?? 0;
          if (inFlight === 0) {
            idleSince ??= Date.now();
            if (Date.now() - idleSince >= 500) break;
          } else {
            idleSince = null;
          }
          await sleep(100);
        }
      }

      const info = await refreshSessionInfo(session);
      return json({ navigated: true, requested_url: url, url: info.url, title: info.title, wait_until });
    },
  );
}
