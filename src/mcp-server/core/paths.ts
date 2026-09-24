import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The reference server stored everything under ~/.mcpgui. When launched by this app, the MCP
// client passes MCP_DATA_DIR (<userData>/mcp-desktop) so data lives with the rest of the app's
// state; standalone (e.g. from VS Code's mcp.json) there's no MCP_DATA_DIR and it falls back to
// ~/.mcpgui — the original behavior, so both keep working side by side.
export const LEGACY_DATA_DIR = join(homedir(), ".mcpgui");
export const DATA_DIR = resolve(process.env.MCP_DATA_DIR ?? LEGACY_DATA_DIR);

export const APPS_ROOT = join(DATA_DIR, "apps");
export const LAST_APP_FILE = join(DATA_DIR, "last-app.json");
export const SCREENSHOTS_DIR = join(DATA_DIR, "screenshots");

/**
 * One-time carry-over of learned per-app click history from ~/.mcpgui into DATA_DIR. COPIES,
 * never moves — the original Mcpgui project reads ~/.mcpgui and must keep working. Only runs
 * when DATA_DIR has no apps yet, so it never overwrites anything learned here since.
 */
export async function migrateLegacyData(): Promise<{ migrated: boolean }> {
  if (DATA_DIR === resolve(LEGACY_DATA_DIR)) return { migrated: false };
  if (existsSync(APPS_ROOT) || !existsSync(join(LEGACY_DATA_DIR, "apps"))) return { migrated: false };
  await mkdir(DATA_DIR, { recursive: true });
  await cp(join(LEGACY_DATA_DIR, "apps"), APPS_ROOT, { recursive: true, errorOnExist: false, force: false });
  return { migrated: true };
}
