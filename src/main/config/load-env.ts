import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal `.env` loader for the Electron **main process** specifically.
 *
 * Bun auto-loads `.env` for the top-level `bun run dev` process, but that
 * doesn't reliably reach here: `bun run dev` -> `vite` -> vite-plugin-electron
 * spawning the real `electron` binary is several process hops deep, and in
 * practice the spawned Electron main process saw `process.env.TITLE_GEN_*`
 * as `undefined` even though a direct `bun run <script>.ts` saw them fine
 * (verified while debugging why AI title generation silently never fired —
 * see prompts/ai-title-generation.md). Loading the file directly inside the
 * process that actually needs the values sidesteps that chain entirely.
 *
 * No `dotenv` dependency — same reasoning as using `node:sqlite` over
 * `better-sqlite3` in session-store.ts: one less native/npm dependency for
 * a handful of KEY=VALUE lines. Doesn't overwrite anything already present
 * in `process.env` (e.g. a real deployment env should win over the file).
 *
 * Dev-only for now: a packaged production build won't have this file next
 * to it unless it's explicitly bundled as an extra resource — that's a
 * separate, not-yet-needed concern (real secret storage for a shipped app).
 */
export function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;

  const contents = readFileSync(envPath, "utf-8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
