import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APPS_ROOT, DATA_DIR, LAST_APP_FILE } from "../core/paths";
import type { DisplayInfo, ResolvedPoint } from "../win32/displays";

// --- Per-app persistent storage: click history + optional guide.md ---
//
// Each desktop app gets its own directory (slugified name) holding meta.json,
// click_history.json and an optional hand-written guide.md. File formats are unchanged from
// the reference server, so data copied over from ~/.mcpgui loads as-is.

interface AppMeta {
  app_name: string;
  slug: string;
  created_at: string;
  last_used_at: string;
}

export interface ClickHistoryEntry {
  // A stable name for the UI element (e.g. "Save button") that future clicks can reuse instead
  // of re-locating it with vision or accessibility APIs.
  label: string;
  // Stored normalized (0-1000, relative to the owning display) rather than as raw pixels, so a
  // cached location still resolves correctly after a resolution or scaling change.
  normalized_x: number;
  normalized_y: number;
  display_index: number;
  // The display's device name (e.g. "\\.\DISPLAY1") is more stable than its index across
  // monitor reconnects/reordering, so lookups prefer matching on this when available.
  display_name: string;
  click_type: string;
  use_count: number;
  verified_count: number;
  created_at: string;
  last_used_at: string;
}

export interface CurrentApp {
  appName: string;
  slug: string;
  dir: string;
  clickHistory: ClickHistoryEntry[];
}

let currentApp: CurrentApp | null = null;

export function getCurrentApp(): CurrentApp | null {
  return currentApp;
}

function slugifyAppName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

const clickHistoryPath = (dir: string) => join(dir, "click_history.json");

async function loadClickHistory(dir: string): Promise<ClickHistoryEntry[]> {
  const parsed = await readJson<unknown>(clickHistoryPath(dir));
  return Array.isArray(parsed) ? (parsed as ClickHistoryEntry[]) : [];
}

async function loadGuide(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, "guide.md"), "utf-8");
  } catch {
    return null;
  }
}

export async function saveCurrentClickHistory(): Promise<void> {
  if (!currentApp) return;
  await writeFile(clickHistoryPath(currentApp.dir), JSON.stringify(currentApp.clickHistory, null, 2), "utf-8");
}

export async function listVisitedApps() {
  let entries: Dirent[];
  try {
    entries = await readdir(APPS_ROOT, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const apps = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(APPS_ROOT, entry.name);
    const [meta, history, guide] = await Promise.all([readJson<AppMeta>(join(dir, "meta.json")), loadClickHistory(dir), loadGuide(dir)]);
    apps.push({
      app_name: meta?.app_name ?? entry.name,
      slug: entry.name,
      click_count: history.length,
      created_at: meta?.created_at ?? null,
      last_used_at: meta?.last_used_at ?? null,
      has_guide: guide !== null,
    });
  }
  apps.sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));
  return apps;
}

export async function initApp(appName: string) {
  const slug = slugifyAppName(appName);
  const dir = join(APPS_ROOT, slug);
  await mkdir(dir, { recursive: true });

  const existingMeta = await readJson<AppMeta>(join(dir, "meta.json"));
  const now = new Date().toISOString();
  const meta: AppMeta = {
    app_name: existingMeta?.app_name ?? appName,
    slug,
    created_at: existingMeta?.created_at ?? now,
    last_used_at: now,
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  const [clickHistory, guide] = await Promise.all([loadClickHistory(dir), loadGuide(dir)]);
  currentApp = { appName: meta.app_name, slug, dir, clickHistory };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LAST_APP_FILE, JSON.stringify({ app_name: meta.app_name, slug, updated_at: now }, null, 2), "utf-8");

  return { app_name: meta.app_name, slug, is_new: existingMeta === null, click_history_count: clickHistory.length, guide };
}

export async function clearCurrentClickHistory(): Promise<void> {
  if (!currentApp) return;
  currentApp.clickHistory = [];
  await rm(clickHistoryPath(currentApp.dir), { force: true });
}

// "Persist successful locations": once a click has been labeled, later calls can pass the same
// label instead of x/y and skip a fresh screenshot/vision pass or accessibility lookup.
export function findCachedLocation(history: ClickHistoryEntry[], label: string): ClickHistoryEntry | undefined {
  return history.find((h) => h.label.toLowerCase() === label.toLowerCase());
}

// Converts a cached (normalized, display-relative) entry back to a global point using the
// CURRENT display layout — what lets a cached label survive a resolution or scaling change.
export function resolveCachedLocation(entry: ClickHistoryEntry, displays: DisplayInfo[]): ResolvedPoint {
  const display = displays.find((d) => d.name === entry.display_name) ?? displays[entry.display_index] ?? displays[0];
  if (!display) {
    return { x: Math.round(entry.normalized_x), y: Math.round(entry.normalized_y), displayIndex: entry.display_index };
  }
  return {
    x: Math.round(display.left + (entry.normalized_x / 1000) * display.width),
    y: Math.round(display.top + (entry.normalized_y / 1000) * display.height),
    displayIndex: display.index,
  };
}

// Upserts by label (case-insensitive) so a fresh click on the same named element updates its
// cached location and counts in place, rather than growing the history with stale duplicates.
export function upsertClickHistory(
  history: ClickHistoryEntry[],
  params: { label: string; display: DisplayInfo; globalX: number; globalY: number; clickType: string; verified: boolean },
): void {
  const now = new Date().toISOString();
  const existingIndex = history.findIndex((h) => h.label.toLowerCase() === params.label.toLowerCase());
  const existing = existingIndex !== -1 ? history[existingIndex] : undefined;

  const entry: ClickHistoryEntry = {
    label: params.label,
    normalized_x: ((params.globalX - params.display.left) / params.display.width) * 1000,
    normalized_y: ((params.globalY - params.display.top) / params.display.height) * 1000,
    display_index: params.display.index,
    display_name: params.display.name,
    click_type: params.clickType,
    use_count: (existing?.use_count ?? 0) + 1,
    verified_count: (existing?.verified_count ?? 0) + (params.verified ? 1 : 0),
    created_at: existing?.created_at ?? now,
    last_used_at: now,
  };

  if (existingIndex !== -1) history[existingIndex] = entry;
  else history.push(entry);
}

// Bumps use/verified counts for a cache-hit reuse (label only, no fresh x/y) without moving the
// stored location.
export function markClickHistoryUsed(history: ClickHistoryEntry[], label: string, verified: boolean): void {
  const idx = history.findIndex((h) => h.label.toLowerCase() === label.toLowerCase());
  const existing = idx !== -1 ? history[idx] : undefined;
  if (!existing) return;
  history[idx] = {
    ...existing,
    use_count: existing.use_count + 1,
    verified_count: existing.verified_count + (verified ? 1 : 0),
    last_used_at: new Date().toISOString(),
  };
}
