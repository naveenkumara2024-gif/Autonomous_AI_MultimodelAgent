import * as z from "zod";
import { type AppEntry, normalizeAppQuery, resolveApp } from "../app-memory/app-resolver";
import { launchCache } from "../app-memory/launch-cache";
import { errorMessage, sleep } from "../core/async";
import type { DefineTool } from "../core/define-tool";
import { fail, json } from "../core/result";
import { appLauncherWorker } from "../powershell/workers";

// --- launch_app: open or switch to an installed app, deterministically (prompts/stage-6, A) ---
//
// Resolution ladder: launch cache (verified) → Start-menu index (all Start-registered apps,
// UWP and Win32, warm in memory) → taskbar buttons (pinned apps that aren't in the Start menu;
// only visible to UI Automation while the taskbar is shown — it vanishes when auto-hidden).
// Then: already in front → nothing; open elsewhere → restore + focus its most recent window;
// not open → activate via shell:AppsFolder (or its taskbar button), and confirm a window
// appeared. No mouse movement, no keystrokes, no fresh powershell.exe, no model involved.

interface TaskbarApp extends AppEntry {
  pinned: boolean;
  running_windows: number;
}

interface AppWindows {
  ok: boolean;
  count: number;
  foreground: boolean;
  windows: Array<{ title: string; minimized: boolean }>;
}

type Target = AppEntry & { source: "start-menu" | "taskbar"; tier: "cache" | "start-menu" | "taskbar" };

const INDEX_TTL_MS = 5 * 60_000;
const CONFIRM_TIMEOUT_MS = 6000;
const CONFIRM_POLL_MS = 150;

let index: { apps: AppEntry[]; at: number } | null = null;
let indexLoading: Promise<AppEntry[]> | null = null;

async function startMenuApps(forceRefresh = false): Promise<AppEntry[]> {
  if (!forceRefresh && index && Date.now() - index.at < INDEX_TTL_MS) return index.apps;
  if (!indexLoading) {
    indexLoading = appLauncherWorker
      .request<{ ok: boolean; apps?: AppEntry[]; error?: string }>({ action: "start_apps" }, 20_000)
      .then((r) => {
        if (!r.ok || !Array.isArray(r.apps)) throw new Error(r.error ?? "Start-menu enumeration failed.");
        index = { apps: r.apps, at: Date.now() };
        return r.apps;
      })
      .finally(() => {
        indexLoading = null;
      });
  }
  return indexLoading;
}

async function taskbarApps(): Promise<TaskbarApp[]> {
  const r = await appLauncherWorker.request<{ ok: boolean; apps?: TaskbarApp[] }>({ action: "taskbar_apps" }, 10_000);
  return r.ok && Array.isArray(r.apps) ? r.apps : [];
}

const appWindows = (appId: string) => appLauncherWorker.request<AppWindows>({ action: "app_windows", app_id: appId }, 10_000);

/**
 * Pre-loads the launcher worker (PowerShell + UIA + the window-AUMID helper) and the Start-menu
 * index at server start, so the first "open X" doesn't pay ~2s of cold start.
 */
export function warmLauncher(): void {
  appLauncherWorker
    .request({ action: "warm" }, 30_000)
    .then(() => startMenuApps())
    .catch((error) => console.error(`[mcp-desktop] launcher warm-up failed: ${errorMessage(error)}`));
}

async function resolveTarget(query: string): Promise<{ target: Target } | { target: null; ambiguous: boolean; candidates: AppEntry[] }> {
  // 1. Cache — only trusted after checking the AppID still exists.
  const cached = launchCache.get(query);
  if (cached) {
    const apps = cached.source === "taskbar" ? await taskbarApps() : await startMenuApps();
    if (apps.some((a) => a.app_id === cached.app_id)) {
      return { target: { app_id: cached.app_id, name: cached.display_name, source: cached.source, tier: "cache" } };
    }
    // Hidden taskbar or an uninstalled/renamed app: drop the hint and resolve from scratch.
    if (cached.source !== "taskbar") launchCache.invalidate(query);
  }

  // 2. Start-menu index; refreshed once on a miss in case the app was installed since.
  let apps = await startMenuApps();
  let resolution = resolveApp(query, apps);
  if (resolution.kind === "none" && index && Date.now() - index.at > 10_000) {
    apps = await startMenuApps(true);
    resolution = resolveApp(query, apps);
  }
  if (resolution.kind === "match") return { target: { ...resolution.app, source: "start-menu", tier: "start-menu" } };
  if (resolution.kind === "ambiguous") return { target: null, ambiguous: true, candidates: resolution.candidates };

  // 3. Taskbar — apps pinned there but absent from the Start menu.
  const onTaskbar = resolveApp(query, await taskbarApps());
  if (onTaskbar.kind === "match") return { target: { app_id: onTaskbar.app.app_id, name: onTaskbar.app.name, source: "taskbar", tier: "taskbar" } };
  return { target: null, ambiguous: onTaskbar.kind === "ambiguous", candidates: resolution.candidates };
}

function activate(target: Target): void {
  // explorer.exe with shell:AppsFolder\<AUMID> is the shell's own "start this app" path: it
  // launches Store and Win32 apps alike with no exe path, arguments, or elevation.
  Bun.spawn(["explorer.exe", `shell:AppsFolder\\${target.app_id}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

async function waitForWindow(appId: string, signal: AbortSignal): Promise<AppWindows | null> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    const w = await appWindows(appId).catch(() => null);
    if (w?.ok && w.count > 0) return w;
    await sleep(CONFIRM_POLL_MS);
  }
  return null;
}

export function registerLaunchTools(defineTool: DefineTool): void {
  defineTool(
    "launch_app",
    {
      description:
        'Desktop automation tool: open an installed Windows app by name, or switch to it if it is already open — the fastest, most reliable way to "open X". Resolves the name against every Start-menu app (Store/UWP and classic Win32, e.g. "whatsapp", "calculator", "word", "vs code") and taskbar-pinned apps; if the app already has a window it restores and focuses that window instead of starting a second copy; otherwise it starts the app and waits until its window appears. No mouse or keyboard input. Returns { action: "launched" | "focused" | "none", confirmed, app_id, display_name }; on an unclear name it launches nothing and returns candidates to choose from.',
      inputSchema: {
        app_name: z.string().min(1).describe('The app to open, as the user named it (e.g. "WhatsApp", "calculator", "Microsoft Word").'),
      },
    },
    async ({ app_name }, { signal }) => {
      const started = Date.now();
      // Raw name for scoring (the resolver tries several normal forms); the cache normalizes keys.
      const query = app_name.trim();
      if (!normalizeAppQuery(query)) return fail("app_name must name an app.");

      const resolved = await resolveTarget(query);
      if (!resolved.target) {
        return json({
          launched: false,
          found: false,
          ambiguous: resolved.ambiguous,
          candidates: resolved.candidates.map((c) => c.name),
          message: resolved.ambiguous
            ? `"${app_name}" matches several apps equally well; call launch_app again with the exact name of one candidate.`
            : `No installed app matches "${app_name}".${resolved.candidates.length ? " Closest names are listed in candidates." : ""}`,
          ms: Date.now() - started,
        });
      }
      const target = resolved.target;
      const base = { app_id: target.app_id, display_name: target.name, tier: target.tier };

      const before = await appWindows(target.app_id);
      let action: "none" | "focused" | "launched";
      let confirmed: boolean;
      let windowTitle: string | undefined;

      if (before.ok && before.count > 0 && before.foreground) {
        action = "none";
        confirmed = true;
        windowTitle = before.windows[0]?.title;
      } else if (before.ok && before.count > 0) {
        const focus = await appLauncherWorker.request<{ ok: boolean; foreground?: boolean; title?: string; error?: string }>({ action: "focus_app", app_id: target.app_id }, 10_000);
        action = "focused";
        confirmed = Boolean(focus.ok && focus.foreground);
        windowTitle = focus.title;
      } else {
        if (target.source === "taskbar") {
          const r = await appLauncherWorker.request<{ ok: boolean; error?: string }>({ action: "invoke_taskbar", app_id: target.app_id }, 10_000);
          if (!r.ok) return fail(`Could not start ${target.name} from its taskbar button: ${r.error ?? "unknown error"}.`);
        } else {
          activate(target);
        }
        action = "launched";
        const after = await waitForWindow(target.app_id, signal);
        confirmed = after !== null;
        windowTitle = after?.windows[0]?.title;
        // A freshly started window can open behind the current one; bring it forward once.
        if (after && !after.foreground) {
          const focus = await appLauncherWorker.request<{ ok: boolean; foreground?: boolean }>({ action: "focus_app", app_id: target.app_id }, 10_000).catch(() => null);
          confirmed = Boolean(focus?.foreground) || confirmed;
        }
      }

      const ms = Date.now() - started;
      if (confirmed) launchCache.record(query, { app_id: target.app_id, display_name: target.name, source: target.source, ms });
      else if (target.tier === "cache") launchCache.invalidate(query);

      const message =
        action === "none"
          ? `${target.name} is already open and in front.`
          : action === "focused"
            ? `${target.name} was already open; switched to it${confirmed ? "" : " (Windows may not have brought it to the front — check before typing into it)"}.`
            : confirmed
              ? `Started ${target.name}; its window is open.`
              : `Started ${target.name}, but no window was confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s — it may still be loading. Do NOT launch it again; check with find_element or a screenshot.`;

      return json({ launched: action === "launched", already_open: action !== "launched", action, confirmed, ...base, window_title: windowTitle ?? null, ms, message });
    },
  );
}
