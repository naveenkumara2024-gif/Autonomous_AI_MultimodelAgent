import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  hostOf,
  PRESET_IDS,
  PRESETS,
  presetById,
  type Validated,
  validateApiKey,
  validateBaseUrl,
  validateModel,
  validateName,
} from "./provider-presets";

/**
 * The user's model providers (prompts/settings-providers.md): which one is active, and each
 * one's base URL, automation model and API key. The key is encrypted at rest through an
 * injected cipher (Electron safeStorage in the app) and is only ever handed out by
 * `resolveActive()` / `resolveKey()` inside the main process — `list()` never contains it.
 */

export interface Cipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

type ProviderKind = "preset" | "custom";

interface StoredProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  /** Cipher output; null = no key saved. */
  keyEnc: string | null;
  /** Last 4 characters of the key, so the UI can show "saved, ending 1a2b". */
  keyHint: string | null;
}

interface StoreFile {
  version: 1;
  activeId: string;
  providers: StoredProvider[];
}

/** What the renderer sees. Deliberately has no key. */
export interface ProviderPublic {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  /** The system-chosen session-title model for this provider (read-only in the UI). */
  titleModel: string;
  hasKey: boolean;
  keyHint: string | null;
  active: boolean;
  keyUrl: string | null;
  blurb: string | null;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  titleModel: string;
}

export interface SaveProviderInput {
  /** Omit to create a custom provider. */
  id?: string;
  /** Custom providers only; presets keep their name. */
  name?: string;
  baseUrl: string;
  model: string;
  /** undefined = keep the saved key, null = remove it, string = replace it. */
  apiKey?: string | null;
}

export interface ProviderStoreOptions {
  filePath: string;
  cipher: Cipher;
  /** Where the one-time `.env` import reads from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Model to carry over from the old config.defaultModel on the one-time import. */
  importModel?: string;
  log?: (line: string) => void;
}

const NARA_HOST = "router.bynara.id";
const IMPORTED_NAME = "Imported from .env";

function lastFour(key: string): string {
  return key.length > 8 ? key.slice(-4) : "";
}

export class ProviderStore {
  private file: StoreFile;
  private readonly log: (line: string) => void;

  constructor(private readonly options: ProviderStoreOptions) {
    this.log = options.log ?? (() => {});
    this.file = this.load();
  }

  // --- reads ----------------------------------------------------------------------------

  get activeId(): string {
    return this.file.activeId;
  }

  list(): ProviderPublic[] {
    return this.file.providers.map((p) => this.toPublic(p));
  }

  /** The active provider with its key, or null when it has no (readable) key. Main process only. */
  resolveActive(): ResolvedProvider | null {
    const provider = this.file.providers.find((p) => p.id === this.file.activeId);
    if (!provider) return null;
    const apiKey = this.decryptKey(provider);
    if (!apiKey) return null;
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey, model: provider.model, titleModel: this.titleModelOf(provider) };
  }

  /** A saved provider's key, for testing it without retyping. Main process only. */
  resolveKey(id: string): string | null {
    const provider = this.file.providers.find((p) => p.id === id);
    return provider ? this.decryptKey(provider) : null;
  }

  // --- writes ---------------------------------------------------------------------------

  save(input: SaveProviderInput): Validated<ProviderPublic> {
    const existing = input.id ? this.file.providers.find((p) => p.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, error: "That provider no longer exists." };

    const kind: ProviderKind = existing?.kind ?? "custom";
    let name = existing?.name ?? "";
    if (kind === "custom") {
      const checked = validateName(input.name);
      if (!checked.ok) return checked;
      name = checked.value;
    }
    const baseUrl = validateBaseUrl(input.baseUrl);
    if (!baseUrl.ok) return baseUrl;
    const model = validateModel(input.model);
    if (!model.ok) return model;

    let keyEnc = existing?.keyEnc ?? null;
    let keyHint = existing?.keyHint ?? null;
    if (input.apiKey === null) {
      keyEnc = null;
      keyHint = null;
    } else if (typeof input.apiKey === "string") {
      const key = validateApiKey(input.apiKey);
      if (!key.ok) return key;
      if (!this.options.cipher.available()) {
        return { ok: false, error: "Secure storage isn't available on this system, so the key can't be saved safely." };
      }
      keyEnc = this.options.cipher.encrypt(key.value);
      keyHint = lastFour(key.value) || null;
    }

    const next: StoredProvider = { id: existing?.id ?? randomUUID(), kind, name, baseUrl: baseUrl.value, model: model.value, keyEnc, keyHint };
    this.file.providers = existing ? this.file.providers.map((p) => (p.id === next.id ? next : p)) : [...this.file.providers, next];
    this.persist();
    return { ok: true, value: this.toPublic(next) };
  }

  remove(id: string): Validated<null> {
    const provider = this.file.providers.find((p) => p.id === id);
    if (!provider) return { ok: false, error: "That provider no longer exists." };
    if (provider.kind === "preset") return { ok: false, error: `${provider.name} is built in and can't be removed. You can clear its key instead.` };
    this.file.providers = this.file.providers.filter((p) => p.id !== id);
    if (this.file.activeId === id) {
      this.file.activeId = (this.file.providers.find((p) => p.keyEnc) ?? this.file.providers[0]!).id;
    }
    this.persist();
    return { ok: true, value: null };
  }

  setActive(id: string): Validated<null> {
    if (!this.file.providers.some((p) => p.id === id)) return { ok: false, error: "That provider no longer exists." };
    this.file.activeId = id;
    this.persist();
    return { ok: true, value: null };
  }

  // --- internals ------------------------------------------------------------------------

  private titleModelOf(p: StoredProvider): string {
    // A custom provider has no system table entry, so titles reuse its automation model.
    return presetById(p.id)?.titleModel ?? p.model;
  }

  private toPublic(p: StoredProvider): ProviderPublic {
    const preset = presetById(p.id);
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      titleModel: this.titleModelOf(p),
      hasKey: p.keyEnc !== null,
      keyHint: p.keyHint,
      active: p.id === this.file.activeId,
      keyUrl: preset?.keyUrl ?? null,
      blurb: preset?.blurb ?? null,
    };
  }

  private decryptKey(p: StoredProvider): string | null {
    if (!p.keyEnc) return null;
    try {
      return this.options.cipher.decrypt(p.keyEnc) || null;
    } catch {
      this.log(`could not decrypt the saved key for "${p.name}" (re-enter it in Settings)`);
      return null;
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const tmp = `${this.options.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2), "utf-8");
    renameSync(tmp, this.options.filePath);
  }

  private load(): StoreFile {
    const { filePath } = this.options;
    if (existsSync(filePath)) {
      try {
        const parsed = this.sanitize(JSON.parse(readFileSync(filePath, "utf-8")));
        if (parsed) return parsed;
      } catch {
        // fall through to the backup-and-recreate path
      }
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        // best effort
      }
      this.log("providers file was unreadable; moved aside and starting fresh");
    }
    const fresh = this.initial();
    this.file = fresh;
    this.persist();
    return fresh;
  }

  private presetsOnly(): StoredProvider[] {
    return PRESETS.map((p) => ({ id: p.id, kind: "preset" as const, name: p.name, baseUrl: p.baseUrl, model: p.model, keyEnc: null, keyHint: null }));
  }

  /** First run: the two presets, with the `.env` agent endpoint imported once if there is one. */
  private initial(): StoreFile {
    const providers = this.presetsOnly();
    let activeId = "nara";

    const env = this.options.env ?? process.env;
    const base = validateBaseUrl(env.AGENT_BASE_URL);
    const key = validateApiKey(env.AGENT_API_KEY);
    if (base.ok && key.ok && this.options.cipher.available()) {
      const keyEnc = this.options.cipher.encrypt(key.value);
      const keyHint = lastFour(key.value) || null;
      const model = this.options.importModel?.trim();
      if (hostOf(base.value) === NARA_HOST) {
        const nara = providers.find((p) => p.id === "nara")!;
        Object.assign(nara, { baseUrl: base.value, keyEnc, keyHint, ...(model ? { model } : {}) });
      } else {
        const id = randomUUID();
        providers.push({ id, kind: "custom", name: IMPORTED_NAME, baseUrl: base.value, model: model ?? "", keyEnc, keyHint });
        activeId = id;
      }
      this.log(`imported the agent endpoint from .env (${hostOf(base.value)})`);
    }
    return { version: 1, activeId, providers };
  }

  private sanitize(raw: unknown): StoreFile | null {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Partial<StoreFile>;
    if (data.version !== 1 || !Array.isArray(data.providers)) return null;

    const seen = new Set<string>();
    const providers: StoredProvider[] = [];
    for (const item of data.providers) {
      const p = item as Partial<StoredProvider> | null;
      if (!p || typeof p.id !== "string" || seen.has(p.id)) continue;
      if (p.kind !== "preset" && p.kind !== "custom") continue;
      if (p.kind === "preset" && !PRESET_IDS.has(p.id)) continue;
      if (typeof p.name !== "string" || typeof p.baseUrl !== "string" || typeof p.model !== "string") continue;
      seen.add(p.id);
      providers.push({
        id: p.id,
        kind: p.kind,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        keyEnc: typeof p.keyEnc === "string" ? p.keyEnc : null,
        keyHint: typeof p.keyHint === "string" ? p.keyHint : null,
      });
    }
    // A preset added in a later version shows up without disturbing anything saved.
    for (const preset of this.presetsOnly()) if (!seen.has(preset.id)) providers.push(preset);

    const activeId = typeof data.activeId === "string" && providers.some((p) => p.id === data.activeId) ? data.activeId : "nara";
    return { version: 1, activeId, providers };
  }
}
