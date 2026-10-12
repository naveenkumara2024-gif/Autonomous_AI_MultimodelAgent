import { describe, expect, test } from "bun:test";
import { describeHttpFailure, listModels, testProvider } from "./provider-client";

const KEY = "sk-test-supersecret-9876";
const input = { baseUrl: "https://llm.test/v1", apiKey: KEY, model: "m1" };

const reply = (status: number, body: unknown, capture?: { url?: string; init?: RequestInit }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) Object.assign(capture, { url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;

describe("testProvider", () => {
  test("a good key + model reports success, latency and the model that answered", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const result = await testProvider(input, { fetchImpl: reply(200, { choices: [{ message: { content: "ok" } }] }, seen) });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("m1 replied");
    expect(seen.url).toBe("https://llm.test/v1/chat/completions");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(seen.init?.body))).toMatchObject({ model: "m1", max_tokens: 16 });
  });

  test("a reasoning model with empty visible content still counts as working", async () => {
    const result = await testProvider(input, { fetchImpl: reply(200, { choices: [{ message: { content: "", reasoning_content: "thinking" } }] }) });
    expect(result.ok).toBe(true);
  });

  test("maps the common failures to plain language", async () => {
    const cases: Array<[number, string]> = [
      [401, "rejected the API key"],
      [402, "out of credits"],
      [404, "model name"],
      [429, "rate-limiting"],
      [503, "having trouble"],
    ];
    for (const [status, text] of cases) {
      const result = await testProvider(input, { fetchImpl: reply(status, { error: { message: "nope" } }) });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      expect(result.message).toContain(text);
    }
  });

  test("the key is scrubbed even when the provider echoes it back", async () => {
    const result = await testProvider(input, { fetchImpl: reply(401, { error: { message: `Invalid key ${KEY}` } }) });
    expect(result.message).not.toContain(KEY);
    expect(result.message).toContain("•••");
  });

  test("a non-OpenAI answer is called out as a wrong base URL", async () => {
    const result = await testProvider(input, { fetchImpl: reply(200, "<html>hello</html>") });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("base URL");
  });

  test("network failures name the host and never include the key", async () => {
    const result = await testProvider(input, {
      fetchImpl: (async () => {
        throw new TypeError(`fetch failed ${KEY}`);
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("llm.test");
    expect(result.message).not.toContain(KEY);
  });
});

describe("listModels", () => {
  test("returns sorted, de-duplicated ids", async () => {
    const result = await listModels(input, { fetchImpl: reply(200, { data: [{ id: "b" }, { id: "a" }, { id: "b" }, { object: "x" }] }) });
    expect(result).toEqual({ ok: true, models: ["a", "b"] });
  });

  test("a provider without /models says so instead of failing loudly", async () => {
    const result = await listModels(input, { fetchImpl: reply(404, "not found") });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Type the model name");
  });

  test("an auth failure is reported as such", async () => {
    const result = await listModels(input, { fetchImpl: reply(401, { error: { message: "bad key" } }) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("rejected the API key");
  });
});

describe("describeHttpFailure", () => {
  test("includes the provider's own message, trimmed", () => {
    expect(describeHttpFailure(400, JSON.stringify({ error: { message: "tool_choice unsupported" } }), KEY)).toContain("tool_choice unsupported");
  });
});
