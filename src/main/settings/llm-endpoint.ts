/**
 * One place that answers "which base URL / key / model should this model call use right now?"
 * (prompts/settings-providers.md). The agent client, the title generator and the voice
 * translator all ask here instead of reading env vars themselves.
 *
 * - Once the app has installed the provider resolver (Electron main does this at startup), the
 *   ACTIVE PROVIDER from Settings is the only source — there is no silent fallback to `.env`,
 *   so clearing a key in Settings really stops the calls.
 * - With no resolver installed (unit tests, a bare dev run) the old env vars keep working, which
 *   is also what kept every pre-existing test valid.
 */

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
}

export interface TitleEndpoint extends LlmEndpoint {
  model: string;
}

export interface ActiveProviderInfo extends LlmEndpoint {
  id: string;
  name: string;
  model: string;
  titleModel: string;
}

export interface EndpointResolver {
  active(): ActiveProviderInfo | null;
  /** Shown when nothing is usable, so the error says what to do. */
  describeMissing(): string;
}

let resolver: EndpointResolver | null = null;

export function installEndpointResolver(next: EndpointResolver | null): void {
  resolver = next;
}

function clean(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The endpoint for agent turns, or null when nothing is configured. */
export function agentEndpoint(): LlmEndpoint | null {
  if (resolver) {
    const active = resolver.active();
    return active ? { baseUrl: clean(active.baseUrl), apiKey: active.apiKey } : null;
  }
  const baseUrl = process.env.AGENT_BASE_URL;
  const apiKey = process.env.AGENT_API_KEY;
  return baseUrl && apiKey ? { baseUrl: clean(baseUrl), apiKey } : null;
}

/** The model the active provider is set to use for automation, or null when env-driven. */
export function activeAgentModel(): string | null {
  return resolver?.active()?.model ?? null;
}

/** The active provider's name, for the "Settings" chip and error messages. */
export function activeProviderName(): string | null {
  return resolver?.active()?.name ?? null;
}

/**
 * The model to use for voice translation. `configModel` (config.voiceTranslationModel) was
 * written for the Nara Router's catalogue, so it only applies there; any other provider gets
 * its own configured automation model, because a Nara model name means nothing elsewhere.
 */
export function translationModel(configModel: string): string {
  const active = resolver?.active();
  if (!active || active.id === "nara") return configModel;
  return active.model;
}

/**
 * The title endpoint. The title model is chosen by the system from the active provider
 * (it is not a user setting); TITLE_GEN_* in `.env` is only the fallback when no provider
 * key is configured.
 */
export function titleEndpoint(): TitleEndpoint | null {
  const active = resolver?.active();
  if (active) return { baseUrl: clean(active.baseUrl), apiKey: active.apiKey, model: active.titleModel };
  const baseUrl = process.env.TITLE_GEN_BASE_URL;
  const apiKey = process.env.TITLE_GEN_API_KEY;
  const model = process.env.TITLE_GEN_MODEL;
  return baseUrl && apiKey && model ? { baseUrl: clean(baseUrl), apiKey, model } : null;
}

/** What to tell the user when `agentEndpoint()` is null. */
export function missingEndpointMessage(): string {
  return resolver ? resolver.describeMissing() : "AGENT_BASE_URL / AGENT_API_KEY are not set (see .env.example).";
}
