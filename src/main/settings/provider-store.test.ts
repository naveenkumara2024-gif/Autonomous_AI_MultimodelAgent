import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Cipher, ProviderStore, type ProviderStoreOptions } from "./provider-store";

// A reversible stand-in for safeStorage that is obviously not plaintext.
const fakeCipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (plain) => `enc:${Buffer.from(plain, "utf-8").toString("base64")}`,
  decrypt: (encoded) => {
    if (!encoded.startsWith("enc:")) throw new Error("bad ciphertext");
    return Buffer.from(encoded.slice(4), "base64").toString("utf-8");
  },
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "providers-"));
  file = path.join(dir, "providers.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (extra: Partial<ProviderStoreOptions> = {}) => new ProviderStore({ filePath: file, cipher: fakeCipher(), env: {}, ...extra });

describe("first run", () => {
  test("creates the two presets, Nara Router active, no keys", () => {
    const store = open();
    expect(store.list().map((p) => p.id)).toEqual(["nara", "openrouter"]);
    expect(store.activeId).toBe("nara");
    expect(store.list().every((p) => !p.hasKey)).toBe(true);
    expect(store.resolveActive()).toBeNull();
  });

  test("imports the .env agent endpoint into Nara Router when the host is router.bynara.id", () => {
    const store = open({ env: { AGENT_BASE_URL: "https://router.bynara.id/v1/", AGENT_API_KEY: "sk-secret-1234" }, importModel: "agnes-2.5-flash" });
    const nara = store.list().find((p) => p.id === "nara")!;
    expect(nara.hasKey).toBe(true);
    expect(nara.keyHint).toBe("1234");
    expect(store.resolveActive()).toMatchObject({ id: "nara", baseUrl: "https://router.bynara.id/v1", apiKey: "sk-secret-1234", model: "agnes-2.5-flash" });
  });

  test("imports any other host as a custom provider and makes it active", () => {
    const store = open({ env: { AGENT_BASE_URL: "https://llm.example.com/v1", AGENT_API_KEY: "sk-other-9999" }, importModel: "my-model" });
    const active = store.resolveActive()!;
    expect(active.name).toBe("Imported from .env");
    expect(active.baseUrl).toBe("https://llm.example.com/v1");
    expect(active.model).toBe("my-model");
    expect(store.list().find((p) => p.id === "nara")!.hasKey).toBe(false);
  });

  test("does not import when secure storage is unavailable", () => {
    const store = open({ cipher: fakeCipher(false), env: { AGENT_BASE_URL: "https://router.bynara.id/v1", AGENT_API_KEY: "sk-x-1234" } });
    expect(store.resolveActive()).toBeNull();
  });
});

describe("keys never leak", () => {
  test("the public list and the file on disk contain no plaintext key", () => {
    const store = open();
    store.save({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKey: "sk-or-v1-supersecretvalue" });
    expect(JSON.stringify(store.list())).not.toContain("supersecretvalue");
    const onDisk = readFileSync(file, "utf-8");
    expect(onDisk).not.toContain("supersecretvalue");
    expect(onDisk).toContain("enc:");
    expect(store.resolveKey("openrouter")).toBe("sk-or-v1-supersecretvalue");
  });

  test("a key survives a restart", () => {
    open().save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "agnes-2.5-flash", apiKey: "sk-persist-0001" });
    expect(open().resolveKey("nara")).toBe("sk-persist-0001");
  });

  test("refuses to save a key when secure storage is unavailable (never falls back to plaintext)", () => {
    const store = open({ cipher: fakeCipher(false) });
    const result = store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m", apiKey: "sk-abcdef-1234" });
    expect(result.ok).toBe(false);
    expect(existsSync(file) ? readFileSync(file, "utf-8") : "").not.toContain("abcdef");
  });

  test("an unreadable ciphertext resolves to no key rather than throwing", () => {
    const store = open();
    store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "m", apiKey: "sk-abcdef-1234" });
    const data = JSON.parse(readFileSync(file, "utf-8"));
    data.providers.find((p: { id: string }) => p.id === "nara").keyEnc = "garbage";
    writeFileSync(file, JSON.stringify(data));
    expect(open().resolveActive()).toBeNull();
  });
});

describe("editing", () => {
  test("keeps the saved key when none is supplied, replaces or clears it on request", () => {
    const store = open();
    store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "a", apiKey: "sk-first-1111" });
    store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "b" });
    expect(store.resolveKey("nara")).toBe("sk-first-1111");
    expect(store.list().find((p) => p.id === "nara")!.model).toBe("b");
    store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "b", apiKey: "sk-second-2222" });
    expect(store.resolveKey("nara")).toBe("sk-second-2222");
    store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "b", apiKey: null });
    expect(store.resolveKey("nara")).toBeNull();
  });

  test("a preset keeps its name even if one is sent", () => {
    const store = open();
    const saved = store.save({ id: "openrouter", name: "Renamed", baseUrl: "https://openrouter.ai/api/v1", model: "x" });
    expect(saved.ok && saved.value.name).toBe("OpenRouter");
  });

  test("validation errors come back as results, not exceptions, and change nothing", () => {
    const store = open();
    const before = JSON.stringify(store.list());
    expect(store.save({ id: "nara", baseUrl: "http://evil.example/v1", model: "m" }).ok).toBe(false);
    expect(store.save({ id: "nara", baseUrl: "https://router.bynara.id/v1", model: "has space" }).ok).toBe(false);
    expect(store.save({ baseUrl: "https://x.com/v1", model: "m", name: "" }).ok).toBe(false);
    expect(JSON.stringify(store.list())).toBe(before);
  });
});

describe("custom providers", () => {
  const create = (store: ProviderStore) => {
    const r = store.save({ name: "Local Ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1", apiKey: "ollama-key-0000" });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  test("can be added, made active and used; its title model is its automation model", () => {
    const store = open();
    const custom = create(store);
    expect(custom.kind).toBe("custom");
    expect(store.setActive(custom.id).ok).toBe(true);
    expect(store.resolveActive()).toMatchObject({ name: "Local Ollama", model: "llama3.1", titleModel: "llama3.1" });
  });

  test("presets use their system-chosen title model", () => {
    const store = open({ env: { AGENT_BASE_URL: "https://router.bynara.id/v1", AGENT_API_KEY: "sk-nara-0000" } });
    expect(store.resolveActive()!.titleModel).toBe("nemotron-3-ultra-free");
  });

  test("deleting the active one falls back to a provider that has a key", () => {
    const store = open();
    store.save({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKey: "sk-or-v1-abcd-5555" });
    const custom = create(store);
    store.setActive(custom.id);
    expect(store.remove(custom.id).ok).toBe(true);
    expect(store.activeId).toBe("openrouter");
  });

  test("presets can't be deleted", () => {
    const result = open().remove("nara");
    expect(result.ok).toBe(false);
  });
});

describe("robustness", () => {
  test("a corrupt file is moved aside and replaced, not crashed on", () => {
    writeFileSync(file, "{ this is not json");
    const store = open();
    expect(store.list()).toHaveLength(2);
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  test("unknown or invalid entries are dropped and a missing preset is re-added", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        activeId: "ghost",
        providers: [
          { id: "nara", kind: "preset", name: "Nara Router", baseUrl: "https://router.bynara.id/v1", model: "m", keyEnc: null, keyHint: null },
          { id: "bogus", kind: "preset", name: "x", baseUrl: "https://x.com", model: "m", keyEnc: null, keyHint: null },
          { id: "c1", kind: "custom", name: 5, baseUrl: "https://x.com", model: "m" },
        ],
      }),
    );
    const store = open();
    expect(store.list().map((p) => p.id)).toEqual(["nara", "openrouter"]);
    expect(store.activeId).toBe("nara");
  });
});
