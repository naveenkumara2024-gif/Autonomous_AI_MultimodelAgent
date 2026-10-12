import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentConfig } from "../config/config-store";
import { type Cipher, ProviderStore } from "./provider-store";
import { type SettingsSnapshot, SettingsService } from "./settings-service";

const cipher: Cipher = {
  available: () => true,
  encrypt: (p) => `enc:${Buffer.from(p).toString("base64")}`,
  decrypt: (e) => Buffer.from(e.slice(4), "base64").toString("utf-8"),
};

const baseConfig = (): AgentConfig =>
  ({
    defaultModel: "agnes-2.5-flash",
    allowScreenshotsToModel: true,
    actionCacheEnabled: true,
    automationOverlayEnabled: true,
    automationMinimizeMainWindow: true,
    voiceLanguage: "auto",
  }) as unknown as AgentConfig;

let dir: string;
let calls: Array<{ url: string; auth: string }>;
let changes: SettingsSnapshot[];
let saved: AgentConfig[];

function make(fetchStatus = 200) {
  const config = baseConfig();
  const store = new ProviderStore({ filePath: path.join(dir, "providers.json"), cipher, env: {} });
  const service = new SettingsService({
    store,
    config,
    saveConfig: (c) => void saved.push({ ...c }),
    secureStorageAvailable: () => true,
    onChange: (s) => void changes.push(s),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "") });
      return new Response(JSON.stringify(fetchStatus === 200 ? { choices: [{ message: { content: "ok" } }], data: [{ id: "m-a" }] } : { error: { message: "bad" } }), { status: fetchStatus });
    }) as typeof fetch,
  });
  return { service, store, config };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "settings-"));
  calls = [];
  changes = [];
  saved = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("snapshot", () => {
  test("lists providers, the general toggles, and has no key anywhere", () => {
    const { service } = make();
    service.saveProvider({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "agnes-2.5-flash", apiKey: "sk-secret-value-1234" });
    const snap = service.snapshot();
    expect(snap.providers.map((p) => p.id)).toEqual(["nara", "openrouter"]);
    expect(snap.general.automationOverlayEnabled).toBe(true);
    expect(snap.active).toEqual({ id: "nara", name: "Nara Router", model: "agnes-2.5-flash" });
    expect(JSON.stringify(snap)).not.toContain("secret-value");
  });

  test("active is null until the active provider has a key", () => {
    expect(make().service.snapshot().active).toBeNull();
  });
});

describe("changes notify open windows", () => {
  test("save, activate and delete each emit a snapshot; a failed save does not", () => {
    const { service } = make();
    service.saveProvider({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKey: "sk-or-v1-aaaa-1111" });
    service.setActive("openrouter");
    const custom = service.saveProvider({ name: "Mine", baseUrl: "https://llm.example.com/v1", model: "m" });
    expect(changes).toHaveLength(3);
    service.saveProvider({ id: "openrouter", baseUrl: "not a url", model: "m" });
    expect(changes).toHaveLength(3);
    if (custom.ok) service.deleteProvider(custom.value.id);
    expect(changes).toHaveLength(4);
    expect(changes.at(-1)!.activeId).toBe("openrouter");
  });
});

describe("test connection", () => {
  test("uses the key typed in the form, even for an unsaved edit", async () => {
    const { service } = make();
    const result = await service.test({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-typed-0000", model: "openrouter/free" });
    expect(result.ok && result.value.ok).toBe(true);
    expect(calls[0]).toEqual({ url: "https://openrouter.ai/api/v1/chat/completions", auth: "Bearer sk-typed-0000" });
  });

  test("falls back to the saved key when the field is blank, without exposing it", async () => {
    const { service } = make();
    service.saveProvider({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m", apiKey: "sk-saved-5678" });
    const result = await service.test({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m" });
    expect(calls[0]!.auth).toBe("Bearer sk-saved-5678");
    expect(JSON.stringify(result)).not.toContain("sk-saved-5678");
  });

  test("no key anywhere -> a clear message, no request", async () => {
    const { service } = make();
    const result = await service.test({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m" });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a rejected key is a normal result (ok:false inside), not an exception", async () => {
    const { service } = make(401);
    const result = await service.test({ baseUrl: "https://llm.example.com/v1", apiKey: "sk-bad-0000", model: "m" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ok).toBe(false);
  });

  test("a bad base URL is rejected before any request", async () => {
    const { service } = make();
    const result = await service.test({ baseUrl: "http://evil.example/v1", apiKey: "sk-x-0000", model: "m" });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("browse models", () => {
  test("lists models using the saved key", async () => {
    const { service } = make();
    service.saveProvider({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m", apiKey: "sk-saved-5678" });
    const result = await service.models({ id: "nara", baseUrl: "https://router.bynara.id/v1" });
    expect(result.ok && result.value.models).toEqual(["m-a"]);
    expect(calls[0]!.url).toBe("https://router.bynara.id/v1/models");
  });
});

describe("general settings", () => {
  test("updates the shared config object (so toggles apply live) and persists it", () => {
    const { service, config } = make();
    const result = service.updateGeneral({ automationOverlayEnabled: false, voiceLanguage: "ta" });
    expect(result.ok).toBe(true);
    expect(config.automationOverlayEnabled).toBe(false);
    expect(config.voiceLanguage).toBe("ta");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.automationOverlayEnabled).toBe(false);
  });

  test("rejects wrong types and unknown languages without changing anything", () => {
    const { service, config } = make();
    expect(service.updateGeneral({ allowScreenshotsToModel: "yes" }).ok).toBe(false);
    expect(service.updateGeneral({ voiceLanguage: "fr" }).ok).toBe(false);
    expect(config.allowScreenshotsToModel).toBe(true);
    expect(saved).toHaveLength(0);
  });

  test("ignores keys it doesn't own", () => {
    const { service, config } = make();
    service.updateGeneral({ defaultModel: "hacked", actionCacheEnabled: false });
    expect(config.defaultModel).toBe("agnes-2.5-flash");
    expect(config.actionCacheEnabled).toBe(false);
  });
});
