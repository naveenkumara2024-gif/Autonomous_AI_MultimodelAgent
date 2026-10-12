import { describe, expect, test } from "bun:test";
import { hostOf, PRESETS, validateApiKey, validateBaseUrl, validateModel, validateName } from "./provider-presets";

describe("presets", () => {
  test("OpenRouter and Nara Router are predefined, with distinct ids and https URLs", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["nara", "openrouter"]);
    for (const p of PRESETS) {
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      expect(p.model).toBeTruthy();
      expect(p.titleModel).toBeTruthy();
    }
  });
});

describe("validateBaseUrl", () => {
  test("accepts https and trims trailing slashes", () => {
    expect(validateBaseUrl(" https://openrouter.ai/api/v1/ ")).toEqual({ ok: true, value: "https://openrouter.ai/api/v1" });
  });

  test("accepts http only for loopback", () => {
    expect(validateBaseUrl("http://localhost:11434/v1")).toEqual({ ok: true, value: "http://localhost:11434/v1" });
    expect(validateBaseUrl("http://127.0.0.1:1234/v1").ok).toBe(true);
    const remote = validateBaseUrl("http://example.com/v1");
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.error).toContain("localhost");
  });

  test("rejects non-http schemes, credentials, queries and garbage", () => {
    for (const bad of ["ftp://x.com/v1", "javascript:alert(1)", "https://user:pw@x.com/v1", "https://x.com/v1?key=1", "not a url", "", "   ", 5, null]) {
      expect(validateBaseUrl(bad).ok).toBe(false);
    }
  });
});

describe("other fields", () => {
  test("name is trimmed, collapsed and length-capped", () => {
    expect(validateName("  My   Server ")).toEqual({ ok: true, value: "My Server" });
    expect(validateName("").ok).toBe(false);
    expect(validateName("x".repeat(41)).ok).toBe(false);
  });

  test("model must be a single token", () => {
    expect(validateModel(" openrouter/free ")).toEqual({ ok: true, value: "openrouter/free" });
    expect(validateModel("two words").ok).toBe(false);
    expect(validateModel("").ok).toBe(false);
  });

  test("api key can't be empty or contain whitespace", () => {
    expect(validateApiKey(" sk-abc ")).toEqual({ ok: true, value: "sk-abc" });
    expect(validateApiKey("sk abc").ok).toBe(false);
    expect(validateApiKey("").ok).toBe(false);
  });

  test("hostOf", () => {
    expect(hostOf("https://router.bynara.id/v1")).toBe("router.bynara.id");
  });
});
