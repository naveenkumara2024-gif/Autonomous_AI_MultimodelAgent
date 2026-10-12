/**
 * Predefined model providers and the validation rules for anything the user types into the
 * settings page (prompts/settings-providers.md). Pure: no Electron, no fs, no fetch.
 */

export interface PresetDef {
  id: string;
  name: string;
  baseUrl: string;
  /** Automation model used until the user changes it. */
  model: string;
  /** Session-title model. Chosen by the system for this provider; never a user setting. */
  titleModel: string;
  /** Where to get a key, shown as a link in the editor. */
  keyUrl: string;
  blurb: string;
}

export const PRESETS: readonly PresetDef[] = [
  {
    id: "nara",
    name: "Nara Router",
    baseUrl: "https://router.bynara.id/v1",
    model: "agnes-2.5-flash",
    titleModel: "nemotron-3-ultra-free",
    keyUrl: "https://router.bynara.id",
    blurb: "Your existing router. Hosts the Agnes models.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    titleModel: "openrouter/free",
    keyUrl: "https://openrouter.ai/keys",
    blurb: "One key for many models. The free router picks a free model that fits each request.",
  },
];

export const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

export function presetById(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * https only, except http for loopback (a local Ollama / LM Studio server). The API key is sent
 * to this URL, so anything that could expose it on the network in cleartext is refused.
 */
export function validateBaseUrl(raw: unknown): Validated<string> {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Enter the provider's base URL." };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "That isn't a valid URL. Include https:// at the start." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The base URL must start with https://." };
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Plain http:// is only allowed for localhost. Use https:// so your key isn't sent in the clear." };
  }
  if (url.username || url.password) return { ok: false, error: "Don't put credentials in the URL; use the API key field." };
  if (url.search || url.hash) return { ok: false, error: "The base URL shouldn't contain a query string or fragment." };
  return { ok: true, value: url.toString().replace(/\/+$/, "") };
}

export function validateName(raw: unknown): Validated<string> {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Give the provider a name." };
  if (name.length > 40) return { ok: false, error: "Keep the name under 40 characters." };
  return { ok: true, value: name };
}

export function validateModel(raw: unknown): Validated<string> {
  const model = typeof raw === "string" ? raw.trim() : "";
  if (!model) return { ok: false, error: "Enter the model name to use for automation." };
  if (model.length > 200 || /\s/.test(model)) return { ok: false, error: "That doesn't look like a model name (no spaces, under 200 characters)." };
  return { ok: true, value: model };
}

export function validateApiKey(raw: unknown): Validated<string> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { ok: false, error: "Enter the API key." };
  if (key.length > 500 || /\s/.test(key)) return { ok: false, error: "That doesn't look like an API key (no spaces)." };
  return { ok: true, value: key };
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
