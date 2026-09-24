import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateTitle, TITLE_MAX_LENGTH } from "./title-generator";

const ENV_KEYS = ["TITLE_GEN_BASE_URL", "TITLE_GEN_API_KEY", "TITLE_GEN_MODEL"] as const;
let savedEnv: Record<string, string | undefined>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TITLE_GEN_BASE_URL = "https://example.invalid/v1";
  process.env.TITLE_GEN_API_KEY = "sk-test";
  process.env.TITLE_GEN_MODEL = "nemotron-3-ultra-free";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("generateTitle", () => {
  test("returns the sanitized title on a successful response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({
        choices: [{ message: { content: '"Kyoto Spring Trip Planning"\n' } }],
      });
    }) as unknown as typeof fetch;

    const title = await generateTitle("help me plan a trip to Kyoto next spring", { fetchImpl });

    expect(title).toBe("Kyoto Spring Trip Planning");
    expect(capturedUrl).toBe("https://example.invalid/v1/chat/completions");
    const body = JSON.parse((capturedInit?.body as string) ?? "{}");
    expect(body.model).toBe("nemotron-3-ultra-free");
    expect(capturedInit?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  test("returns null on a non-OK HTTP response, without throwing", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "bad request" }, 400)) as unknown as typeof fetch;

    const title = await generateTitle("anything", { fetchImpl });

    expect(title).toBeNull();
  });

  test("returns null when the API key is missing, and never calls fetch", async () => {
    delete process.env.TITLE_GEN_API_KEY;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const title = await generateTitle("anything", { fetchImpl });

    expect(title).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null on a malformed response body", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [] })) as unknown as typeof fetch;

    const title = await generateTitle("anything", { fetchImpl });

    expect(title).toBeNull();
  });

  test("truncates an overlong AI response to TITLE_MAX_LENGTH", async () => {
    const longTitle = "a".repeat(TITLE_MAX_LENGTH + 40);
    const fetchImpl = (async () =>
      jsonResponse({ choices: [{ message: { content: longTitle } }] })) as unknown as typeof fetch;

    const title = await generateTitle("anything", { fetchImpl });

    expect(title).not.toBeNull();
    expect(title!.length).toBe(TITLE_MAX_LENGTH + 1); // +1 for the trailing "…"
    expect(title!.endsWith("…")).toBe(true);
  });

  test("returns null when fetch itself rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const title = await generateTitle("anything", { fetchImpl });

    expect(title).toBeNull();
  });
});
