import { ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { ProviderEditor } from "./components/settings/ProviderEditor";
import { AddProviderCard, ProviderCard } from "./components/settings/ProviderCard";
import { SettingRow, SettingsSection } from "./components/settings/primitives";
import type { GeneralSettings, SettingsSnapshot } from "./types";

/**
 * The settings view (prompts/settings-providers.md): which model provider the agent uses, and
 * the automation toggles that already exist in config.json. Everything is applied by main; this
 * page only renders the snapshot it is given and sends changes.
 */

const NEW_PROVIDER = "__new__";

function useGeneralToggle() {
  const [error, setError] = useState<string | null>(null);
  const update = async (patch: Partial<GeneralSettings>) => {
    setError(null);
    const result = await window.agentBridge.updateGeneralSettings(patch);
    if (!result.ok) setError(result.error);
  };
  return { error, update };
}

export function SettingsPage({ settings, onBack }: { settings: SettingsSnapshot | null; onBack: () => void }) {
  const [selectedId, setSelectedId] = useState<string>(NEW_PROVIDER);
  const { error: generalError, update } = useGeneralToggle();
  const [cacheCleared, setCacheCleared] = useState(false);

  // Start on the active provider once the snapshot arrives.
  const [initialised, setInitialised] = useState(false);
  useEffect(() => {
    if (settings && !initialised) {
      setSelectedId(settings.activeId);
      setInitialised(true);
    }
  }, [settings, initialised]);

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  const selected = settings.providers.find((p) => p.id === selectedId) ?? null;
  const g = settings.general;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 pb-12">
        <div className="mx-auto w-full max-w-[720px] space-y-6">
          <div className="flex items-center gap-3 pt-1">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back to chat">
              <ArrowLeft />
            </Button>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-[13px] text-muted-foreground">Choose the model provider and how automation behaves.</p>
            </div>
          </div>

          <SettingsSection
            title="Model provider"
            description="The agent, session titles and voice translation all use the active provider. Keys are encrypted on this computer and never shown again."
          >
            <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2">
              {settings.providers.map((p) => (
                <ProviderCard key={p.id} provider={p} selected={p.id === selectedId} onSelect={() => setSelectedId(p.id)} />
              ))}
              <AddProviderCard selected={selectedId === NEW_PROVIDER} onSelect={() => setSelectedId(NEW_PROVIDER)} />
            </div>
            <ProviderEditor
              key={selected?.id ?? NEW_PROVIDER}
              provider={selected}
              secureStorage={settings.secureStorage}
              onSaved={(id) => setSelectedId(id)}
              onDeleted={() => setSelectedId(settings.activeId)}
            />
          </SettingsSection>

          <SettingsSection title="Automation" description="Changes apply to the next task you run.">
            <SettingRow label="Live activity window" description="A small always-on-top window that shows each step and asks for approval while the agent works.">
              <Switch aria-label="Live activity window" checked={g.automationOverlayEnabled} onCheckedChange={(v) => void update({ automationOverlayEnabled: v })} />
            </SettingRow>
            <SettingRow
              label="Minimize this window while automating"
              description="Gets the app out of the way so you can see the app being controlled."
              disabled={!g.automationOverlayEnabled}
            >
              <Switch
                aria-label="Minimize this window while automating"
                checked={g.automationMinimizeMainWindow}
                disabled={!g.automationOverlayEnabled}
                onCheckedChange={(v) => void update({ automationMinimizeMainWindow: v })}
              />
            </SettingRow>
            <SettingRow
              label="Send screenshots to the model"
              description="Lets the agent see the screen. Password fields are masked first, but screenshots are sent to the active provider. Turn off to use text-based control only."
            >
              <Switch aria-label="Send screenshots to the model" checked={g.allowScreenshotsToModel} onCheckedChange={(v) => void update({ allowScreenshotsToModel: v })} />
            </SettingRow>
            <SettingRow label="Reuse steps that worked before" description="Repeats a verified recipe for a request you've made before, without asking the model again.">
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-foreground/15"
                  onClick={async () => {
                    await window.agentBridge.clearActionCache();
                    setCacheCleared(true);
                    setTimeout(() => setCacheCleared(false), 2500);
                  }}
                >
                  {cacheCleared ? "Cleared" : "Clear saved steps"}
                </Button>
                <Switch aria-label="Reuse steps that worked before" checked={g.actionCacheEnabled} onCheckedChange={(v) => void update({ actionCacheEnabled: v })} />
              </div>
            </SettingRow>
          </SettingsSection>

          <SettingsSection title="Voice" description="Hold the hotkey and speak to give a command.">
            <SettingRow label="Spoken language" description="Tamil is translated to English before it becomes your request. Applies after you restart the app.">
              <select
                aria-label="Spoken language"
                value={g.voiceLanguage}
                onChange={(e) => void update({ voiceLanguage: e.target.value as GeneralSettings["voiceLanguage"] })}
                className="h-9 rounded-md border border-foreground/15 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
              >
                <option value="auto">Auto-detect</option>
                <option value="ta">Tamil → English</option>
              </select>
            </SettingRow>
          </SettingsSection>

          {generalError && <p className="text-[13px] text-destructive">{generalError}</p>}
        </div>
      </div>
    </div>
  );
}
