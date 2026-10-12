import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeAgentModel,
  agentEndpoint,
  type EndpointResolver,
  installEndpointResolver,
  missingEndpointMessage,
  titleEndpoint,
  translationModel,
} from "./llm-endpoint";

const ENV_KEYS = ["AGENT_BASE_URL", "AGENT_API_KEY", "TITLE_GEN_BASE_URL", "TITLE_GEN_API_KEY", "TITLE_GEN_MODEL"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AGENT_BASE_URL = "https://env.test/v1/";
  process.env.AGENT_API_KEY = "env-key";
  process.env.TITLE_GEN_BASE_URL = "https://title.test/v1";
  process.env.TITLE_GEN_API_KEY = "title-key";
  process.env.TITLE_GEN_MODEL = "title-model";
  installEndpointResolver(null);
});
afterEach(() => {
  installEndpointResolver(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const provider = (over: Partial<NonNullable<ReturnType<EndpointResolver["active"]>>> = {}): EndpointResolver => ({
  active: () => ({ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1/", apiKey: "or-key", model: "openrouter/free", titleModel: "openrouter/free", ...over }),
  describeMissing: () => "Add an API key in Settings.",
});

describe("without a provider store (tests, bare dev run)", () => {
  test("the env vars are used, trailing slashes trimmed", () => {
    expect(agentEndpoint()).toEqual({ baseUrl: "https://env.test/v1", apiKey: "env-key" });
    expect(titleEndpoint()).toEqual({ baseUrl: "https://title.test/v1", apiKey: "title-key", model: "title-model" });
    expect(activeAgentModel()).toBeNull();
  });

  test("missing env -> null", () => {
    delete process.env.AGENT_API_KEY;
    expect(agentEndpoint()).toBeNull();
  });
});

describe("with the active provider installed", () => {
  test("the provider wins over env for agent, title and model", () => {
    installEndpointResolver(provider());
    expect(agentEndpoint()).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key" });
    expect(titleEndpoint()).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key", model: "openrouter/free" });
    expect(activeAgentModel()).toBe("openrouter/free");
  });

  test("there is no silent fallback to .env when the provider has no key", () => {
    installEndpointResolver({ active: () => null, describeMissing: () => "Add an API key in Settings." });
    expect(agentEndpoint()).toBeNull();
    expect(missingEndpointMessage()).toBe("Add an API key in Settings.");
    // titles may still use the dedicated env fallback
    expect(titleEndpoint()?.model).toBe("title-model");
  });
});

describe("translationModel", () => {
  test("Nara Router keeps the configured translation model", () => {
    installEndpointResolver(provider({ id: "nara", model: "agnes-2.5-flash" }));
    expect(translationModel("agnes-3-flash")).toBe("agnes-3-flash");
  });

  test("any other provider uses its own model", () => {
    installEndpointResolver(provider());
    expect(translationModel("agnes-3-flash")).toBe("openrouter/free");
  });

  test("with no provider store the configured model is used", () => {
    expect(translationModel("agnes-3-flash")).toBe("agnes-3-flash");
  });
});
