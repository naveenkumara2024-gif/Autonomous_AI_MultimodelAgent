import * as z from "zod";
import {
  clearCurrentClickHistory,
  getCurrentApp,
  initApp,
  listVisitedApps,
  resolveCachedLocation,
} from "../app-memory/app-store";
import type { DefineTool } from "../core/define-tool";
import { fail, json, text } from "../core/result";
import { getDisplays } from "../win32/displays";

const NO_APP = "No app initialized. Call init_app first.";

export function registerAppTools(defineTool: DefineTool): void {
  defineTool(
    "get_all_visited_apps",
    {
      description:
        'Desktop automation tool (OS-level, not browser-scoped): get a list of all applications that have been used before (have stored click history). IMPORTANT: call this BEFORE init_app to check if the app already exists and get its exact name. This prevents duplicate directories from name variations (e.g., "Cursor" vs "cursor" vs "Cursor IDE"). If the app you want is not in the list, use init_app with a new app name.',
      inputSchema: {},
    },
    async () => json({ apps: await listVisitedApps() }),
  );

  defineTool(
    "init_app",
    {
      description:
        "Desktop automation tool: initialize app context for OS-level GUI operations. MUST be called once before starting GUI operations on any DESKTOP application (native windows, not web pages inside a browser tab — for those, the browser_* tools apply instead). IMPORTANT: call get_all_visited_apps FIRST to get the exact app name and avoid duplicate directories. Loads the app's persistent click history and an optional per-app guide file (`<appDirectory>/guide.md`), returned as `guide` so you can follow app-specific guidance. Each application has its own independent storage directory.",
      inputSchema: {
        app_name: z
          .string()
          .min(1)
          .describe('Name of the application (e.g., "Cursor", "Notepad", "Microsoft Word"). REQUIRED. Call get_all_visited_apps first to see previously used apps and get the exact name.'),
      },
    },
    async ({ app_name }) => {
      const trimmed = app_name.trim();
      if (!trimmed) return fail("app_name must not be empty.");
      return json(await initApp(trimmed));
    },
  );

  defineTool(
    "clear_click_history",
    {
      description:
        "Desktop automation tool: clear the click history for the current (OS-level) application. Removes all cached click locations and deletes the persistent storage for this app. Use this only when starting a completely new task or when cached locations are known to be wrong.",
      inputSchema: {},
    },
    async () => {
      const app = getCurrentApp();
      if (!app) return fail(NO_APP);
      await clearCurrentClickHistory();
      return text(`Cleared click history for "${app.appName}".`);
    },
  );

  defineTool(
    "get_click_history",
    {
      description:
        "Desktop automation tool: list the current (OS-level) app's cached (labeled) click locations, most reliable first. Check this BEFORE analyzing a screenshot with vision — a location with a high verified_count has been visually confirmed before and is worth trying via click(label: ...) first. Informational only; it does not click anything.",
      inputSchema: {},
    },
    async () => {
      const app = getCurrentApp();
      if (!app) return fail(NO_APP);
      const displays = getDisplays();
      const sorted = [...app.clickHistory].sort((a, b) => {
        if (b.verified_count !== a.verified_count) return b.verified_count - a.verified_count;
        if (b.use_count !== a.use_count) return b.use_count - a.use_count;
        return b.last_used_at.localeCompare(a.last_used_at);
      });
      const locations = sorted.map((entry) => ({ ...entry, current_screen_position: resolveCachedLocation(entry, displays) }));
      return json({ app_name: app.appName, locations });
    },
  );
}
