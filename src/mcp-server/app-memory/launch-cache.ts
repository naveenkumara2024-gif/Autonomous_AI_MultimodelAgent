import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../core/paths";
import { normalizeAppQuery } from "./app-resolver";

// --- App-resolution cache (prompts/stage-6, design C1) ---
//
// Remembers which installed app a query resolved to after a CONFIRMED launch, so a repeat
// "open whatsapp" skips name scoring. An entry is only a hint: launch_app re-verifies the AppID
// still exists before using it, and invalidates the entry when it doesn't (uninstalled or
// renamed apps self-heal on the next request).

export interface LaunchCacheEntry {
  app_id: string;
  display_name: string;
  /** Where the app was originally found — "taskbar" entries are launched via the taskbar. */
  source: "start-menu" | "taskbar";
  hits: number;
  last_ok_at: string;
  last_ms: number;
}

const MAX_ENTRIES = 200;

export class LaunchCache {
  private entries: Record<string, LaunchCacheEntry> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, LaunchCacheEntry> {
    if (this.entries) return this.entries;
    try {
      const parsed = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf-8")) : {};
      this.entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.entries = {};
    }
    return this.entries!;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.entries ?? {}, null, 2), "utf-8");
    } catch (error) {
      console.error(`[launch-cache] could not save ${this.file}: ${(error as Error).message}`);
    }
  }

  get(query: string): LaunchCacheEntry | undefined {
    return this.load()[normalizeAppQuery(query)];
  }

  record(query: string, entry: { app_id: string; display_name: string; source: LaunchCacheEntry["source"]; ms: number }): void {
    const all = this.load();
    const key = normalizeAppQuery(query);
    if (!key) return;
    const prev = all[key]?.app_id === entry.app_id ? all[key] : undefined;
    all[key] = {
      app_id: entry.app_id,
      display_name: entry.display_name,
      source: entry.source,
      hits: (prev?.hits ?? 0) + 1,
      last_ok_at: new Date().toISOString(),
      last_ms: entry.ms,
    };
    const keys = Object.keys(all);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => all[a]!.last_ok_at.localeCompare(all[b]!.last_ok_at));
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
    }
    this.save();
  }

  invalidate(query: string): void {
    const all = this.load();
    const key = normalizeAppQuery(query);
    if (!(key in all)) return;
    delete all[key];
    this.save();
  }
}

export const launchCache = new LaunchCache(join(DATA_DIR, "launch-cache.json"));
