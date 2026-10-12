import type { IpcMainInvokeEvent } from "electron";
import { registerHandler } from "../client-event-utils";
import type { SaveProviderInput } from "./provider-store";
import type { ProbeInput, SettingsService } from "./settings-service";

/**
 * IPC for the settings page. Every channel is answered only for the MAIN window: the voice
 * overlay and the automation overlay share the preload bridge, and the agent has no path here
 * (no tool exposes settings, and the MCP click guard refuses input aimed at our own windows).
 * Inputs from the renderer are re-shaped field by field; nothing is trusted as typed.
 */

const DENIED = { ok: false as const, error: "Settings can only be changed from the main window." };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function saveInput(raw: unknown): SaveProviderInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    name: str(o.name),
    baseUrl: str(o.baseUrl) ?? "",
    model: str(o.model) ?? "",
    // undefined = keep, null = clear, string = replace
    apiKey: o.apiKey === null ? null : str(o.apiKey),
  };
}

function probeInput(raw: unknown): ProbeInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { id: str(o.id), baseUrl: str(o.baseUrl) ?? "", apiKey: str(o.apiKey), model: str(o.model) ?? "" };
}

export function registerSettingsHandlers(service: SettingsService, isMainWindow: (event: IpcMainInvokeEvent) => boolean): void {
  registerHandler("settings.get", (e) => (isMainWindow(e) ? service.snapshot() : null));
  registerHandler("settings.provider.save", (e, input: unknown) => (isMainWindow(e) ? service.saveProvider(saveInput(input)) : DENIED));
  registerHandler("settings.provider.delete", (e, id: unknown) => (isMainWindow(e) ? service.deleteProvider(String(id)) : DENIED));
  registerHandler("settings.provider.setActive", (e, id: unknown) => (isMainWindow(e) ? service.setActive(String(id)) : DENIED));
  registerHandler("settings.provider.test", async (e, input: unknown) => (isMainWindow(e) ? await service.test(probeInput(input)) : DENIED));
  registerHandler("settings.provider.models", async (e, input: unknown) => (isMainWindow(e) ? await service.models(probeInput(input)) : DENIED));
  registerHandler("settings.general.update", (e, patch: unknown) => (isMainWindow(e) ? service.updateGeneral(patch) : DENIED));
}
