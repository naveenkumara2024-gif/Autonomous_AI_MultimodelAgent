// --- Resolving a spoken/typed app name ("whatsapp", "vs code") to one installed app ---
//
// Dependency-free scoring over the Start-menu index / taskbar list. The resolver only ever
// returns a single app when it is confidently the best match; a tie is reported as ambiguous
// so launch_app can hand the choice back instead of guessing (prompts/stage-6, design A).

export interface AppEntry {
  name: string;
  app_id: string;
}

export type Resolution =
  | { kind: "match"; app: AppEntry; score: number }
  | { kind: "ambiguous"; candidates: AppEntry[] }
  | { kind: "none"; candidates: AppEntry[] };

const MIN_CONFIDENT_SCORE = 50;

function basicNormalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Canonical form of a query: lowercase words, without filler like "the …" / "… app". */
export function normalizeAppQuery(text: string): string {
  return basicNormalize(text)
    .replace(/^(the|app|application)\s+/, "")
    .replace(/\s+(app|application)$/, "");
}

// Start-menu entries that are not "the app": uninstallers, installers, and documents/scripts/
// links. launch_app runs without approval, so it must never pick one of these by accident — a
// query only reaches them by naming them explicitly (e.g. "open foo setup").
const MAINTENANCE_WORDS = /\b(uninstall|uninstaller|remove|setup|installer|install|repair)\b/;
const NON_APP_TARGET = /(^https?:)|\.(url|txt|pdf|chm|html?|ps1|bat|cmd|vbs|js|reg|msi)$/i;

export function isLaunchable(entry: AppEntry, query: string): boolean {
  if (NON_APP_TARGET.test(entry.app_id)) return false;
  const name = normalizeAppQuery(entry.name);
  if (MAINTENANCE_WORDS.test(name) && !MAINTENANCE_WORDS.test(query)) return false;
  return true;
}

export function scoreAppName(query: string, name: string): number {
  // Literal match first, so "notepad" prefers Notepad over Notepad++ (both normalize to "notepad").
  if (name.trim().toLowerCase() === query.trim().toLowerCase()) return 100;
  // The filler-stripped form ("the calculator app" → "calculator") and the full form (so "whats
  // app" keeps its second word) are both tried.
  return Math.max(scoreForm(normalizeAppQuery(query), name), scoreForm(basicNormalize(query), name));
}

function scoreForm(q: string, name: string): number {
  const n = basicNormalize(name);
  if (!q || !n) return 0;
  if (n === q) return 98;
  const qCompact = q.replace(/ /g, "");
  const nWords = n.split(" ");
  if (n.replace(/ /g, "") === qCompact) return 95; // "whats app" → WhatsApp
  if (n.startsWith(`${q} `)) return 80; // "whatsapp" → "WhatsApp Web"
  if (` ${n} `.includes(` ${q} `)) return 70; // "word" → "Microsoft Word"
  if (qCompact.length >= 2 && nWords.length >= 2 && nWords.map((w) => w[0]).join("") === qCompact) return 65; // "vsc"
  const qWords = q.split(" ");
  if (qWords.every((qw) => nWords.some((nw) => nw.startsWith(qw)))) return 50; // "vis stu" → Visual Studio …
  return 0;
}

export function resolveApp(query: string, apps: AppEntry[]): Resolution {
  const q = normalizeAppQuery(query);
  const seen = new Set<string>();
  const scored = apps
    .filter((a) => {
      if (seen.has(a.app_id)) return false;
      seen.add(a.app_id);
      return isLaunchable(a, q);
    })
    .map((app) => ({ app, score: scoreAppName(query, app.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);

  const candidates = scored.slice(0, 5).map((s) => s.app);
  const best = scored[0];
  if (!best || best.score < MIN_CONFIDENT_SCORE) return { kind: "none", candidates };
  const tied = scored.filter((s) => s.score === best.score);
  if (tied.length > 1) return { kind: "ambiguous", candidates: tied.slice(0, 5).map((s) => s.app) };
  return { kind: "match", app: best.app, score: best.score };
}
