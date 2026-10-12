import type { AgentConfig } from "../config/config-store";
import { listModels, type ModelsResult, type TestResult, testProvider } from "./provider-client";
import { type Validated, validateApiKey, validateBaseUrl, validateModel } from "./provider-presets";
import type { ProviderPublic, ProviderStore, SaveProviderInput } from "./provider-store";

/**
 * The settings page's backend (prompts/settings-providers.md). Plain class, no Electron:
 * settings-handlers.ts adds the IPC and sender checks, and this is what the tests drive.
 * Nothing it returns ever contains an API key.
 */

export interface GeneralSettings {
  automationOverlayEnabled: boolean;
  automationMinimizeMainWindow: boolean;
  allowScreenshotsToModel: boolean;
  actionCacheEnabled: boolean;
  voiceLanguage: "auto" | "ta";
}

export interface SettingsSnapshot {
  providers: ProviderPublic[];
  activeId: string;
  /** The provider the agent will actually use now; null when the active one has no key yet. */
  active: { id: string; name: string; model: string } | null;
  general: GeneralSettings;
  /** false = keys can't be saved (no OS credential store). */
  secureStorage: boolean;
}

export interface ProbeInput {
  /** A saved provider whose key to reuse when `apiKey` is blank. */
  id?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface SettingsServiceDeps {
  store: ProviderStore;
  config: AgentConfig;
  saveConfig: (config: AgentConfig) => void;
  secureStorageAvailable: () => boolean;
  /** Called after any change, so open windows can refresh. */
  onChange: (snapshot: SettingsSnapshot) => void;
  fetchImpl?: typeof fetch;
}

const GENERAL_BOOLEANS = ["automationOverlayEnabled", "automationMinimizeMainWindow", "allowScreenshotsToModel", "actionCacheEnabled"] as const;

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  snapshot(): SettingsSnapshot {
    const { store } = this.deps;
    const active = store.resolveActive();
    return {
      providers: store.list(),
      activeId: store.activeId,
      active: active ? { id: active.id, name: active.name, model: active.model } : null,
      general: this.general(),
      secureStorage: this.deps.secureStorageAvailable(),
    };
  }

  saveProvider(input: SaveProviderInput): Validated<ProviderPublic> {
    const result = this.deps.store.save(input);
    if (result.ok) this.changed();
    return result;
  }

  deleteProvider(id: string): Validated<null> {
    const result = this.deps.store.remove(id);
    if (result.ok) this.changed();
    return result;
  }

  setActive(id: string): Validated<null> {
    const result = this.deps.store.setActive(id);
    if (result.ok) this.changed();
    return result;
  }

  async test(input: ProbeInput): Promise<Validated<TestResult>> {
    const target = this.probeTarget(input);
    if (!target.ok) return target;
    const model = validateModel(input.model);
    if (!model.ok) return model;
    return { ok: true, value: await testProvider({ baseUrl: target.value.baseUrl, apiKey: target.value.apiKey, model: model.value }, { fetchImpl: this.deps.fetchImpl }) };
  }

  async models(input: Omit<ProbeInput, "model">): Promise<Validated<ModelsResult>> {
    const target = this.probeTarget(input);
    if (!target.ok) return target;
    return { ok: true, value: await listModels(target.value, { fetchImpl: this.deps.fetchImpl }) };
  }

  updateGeneral(patch: unknown): Validated<GeneralSettings> {
    if (!patch || typeof patch !== "object") return { ok: false, error: "Nothing to update." };
    const next = patch as Record<string, unknown>;
    const { config } = this.deps;

    for (const key of GENERAL_BOOLEANS) {
      if (key in next) {
        if (typeof next[key] !== "boolean") return { ok: false, error: `${key} must be on or off.` };
      }
    }
    if ("voiceLanguage" in next && next.voiceLanguage !== "auto" && next.voiceLanguage !== "ta") {
      return { ok: false, error: "Unsupported voice language." };
    }

    for (const key of GENERAL_BOOLEANS) if (typeof next[key] === "boolean") config[key] = next[key] as boolean;
    if (next.voiceLanguage === "auto" || next.voiceLanguage === "ta") config.voiceLanguage = next.voiceLanguage;
    this.deps.saveConfig(config);
    this.changed();
    return { ok: true, value: this.general() };
  }

  private general(): GeneralSettings {
    const { config } = this.deps;
    return {
      automationOverlayEnabled: config.automationOverlayEnabled,
      automationMinimizeMainWindow: config.automationMinimizeMainWindow,
      allowScreenshotsToModel: config.allowScreenshotsToModel,
      actionCacheEnabled: config.actionCacheEnabled,
      voiceLanguage: config.voiceLanguage,
    };
  }

  /** URL + key to probe: what was typed, or the saved key of that provider when none was typed. */
  private probeTarget(input: { id?: string; baseUrl: string; apiKey?: string }): Validated<{ baseUrl: string; apiKey: string }> {
    const baseUrl = validateBaseUrl(input.baseUrl);
    if (!baseUrl.ok) return baseUrl;

    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      const key = validateApiKey(input.apiKey);
      if (!key.ok) return key;
      return { ok: true, value: { baseUrl: baseUrl.value, apiKey: key.value } };
    }
    const saved = input.id ? this.deps.store.resolveKey(input.id) : null;
    if (!saved) return { ok: false, error: "Enter an API key to test with." };
    return { ok: true, value: { baseUrl: baseUrl.value, apiKey: saved } };
  }

  private changed(): void {
    this.deps.onChange(this.snapshot());
  }
}
