import { AlertCircle, CheckCircle2, Eye, EyeOff, ExternalLink, Loader2, Search, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import type { ProviderModelsResult, ProviderPublic, ProviderTestResult } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Pill } from "./primitives";

interface ProviderEditorProps {
  /** null = creating a new custom provider. */
  provider: ProviderPublic | null;
  secureStorage: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}

type TestState = { phase: "idle" } | { phase: "running" } | { phase: "done"; result: ProviderTestResult } | { phase: "error"; message: string };
type ModelsState = { phase: "idle" } | { phase: "loading" } | { phase: "done"; models: string[] } | { phase: "error"; message: string };

const MODEL_LIST_CAP = 100;

export function ProviderEditor({ provider, secureStorage, onSaved, onDeleted }: ProviderEditorProps) {
  const isNew = provider === null;
  const isCustom = isNew || provider.kind === "custom";

  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://");
  const [model, setModel] = useState(provider?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [models, setModels] = useState<ModelsState>({ phase: "idle" });
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const typedKey = apiKey.trim();
  const dirty = isNew
    ? Boolean(baseUrl.trim() && model.trim() && name.trim())
    : (isCustom && name !== provider.name) || baseUrl !== provider.baseUrl || model !== provider.model || typedKey !== "" || clearKey;
  const hasUsableKey = typedKey !== "" || (provider?.hasKey === true && !clearKey);

  const visibleModels = useMemo(() => {
    if (models.phase !== "done") return [];
    const q = filter.trim().toLowerCase();
    return (q ? models.models.filter((m) => m.toLowerCase().includes(q)) : models.models).slice(0, MODEL_LIST_CAP);
  }, [models, filter]);

  const unlockTouched = () => {
    setNotice(null);
    setError(null);
    setTest({ phase: "idle" });
  };

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.agentBridge.saveProvider({
        id: provider?.id,
        name: isCustom ? name : undefined,
        baseUrl,
        model,
        apiKey: clearKey ? null : typedKey !== "" ? typedKey : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      setClearKey(false);
      setShowKey(false);
      setNotice("Saved.");
      if (isNew) onSaved(result.value.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTest({ phase: "running" });
    try {
      const result = await window.agentBridge.testProvider({ id: provider?.id, baseUrl, apiKey: typedKey || undefined, model });
      setTest(result.ok ? { phase: "done", result: result.value } : { phase: "error", message: result.error });
    } catch (e) {
      setTest({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function browseModels() {
    setModels({ phase: "loading" });
    setFilter("");
    try {
      const result = await window.agentBridge.listProviderModels({ id: provider?.id, baseUrl, apiKey: typedKey || undefined });
      if (!result.ok) setModels({ phase: "error", message: result.error });
      else if (!result.value.ok) setModels({ phase: "error", message: (result.value as ProviderModelsResult).message ?? "Couldn't list models." });
      else setModels({ phase: "done", models: result.value.models });
    } catch (e) {
      setModels({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function activate() {
    if (!provider) return;
    setError(null);
    const result = await window.agentBridge.setActiveProvider(provider.id);
    if (!result.ok) setError(result.error);
  }

  async function remove() {
    if (!provider) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const result = await window.agentBridge.deleteProvider(provider.id);
    if (!result.ok) setError(result.error);
    else onDeleted();
  }

  return (
    <div className="space-y-4 border-t border-border px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{isNew ? "New custom provider" : provider.name}</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {isNew ? "Any OpenAI-compatible endpoint: a hosted router, or a local server such as Ollama or LM Studio." : (provider.blurb ?? "A custom OpenAI-compatible endpoint.")}
          </p>
        </div>
        {provider?.active && <Pill tone="active">Active</Pill>}
      </div>

      {!secureStorage && (
        <div className="flex items-start gap-2 rounded-lg border border-status-stopped/50 bg-status-stopped/10 px-3 py-2 text-[13px] text-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-stopped" />
          Secure storage isn&apos;t available on this system, so API keys can&apos;t be saved safely and saving a key is disabled.
        </div>
      )}

      <div className="grid gap-4">
        {isCustom && (
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                unlockTouched();
              }}
              placeholder="e.g. Local Ollama"
              maxLength={40}
              className="border-foreground/15 bg-background"
            />
          </Field>
        )}

        <Field label="Base URL" hint="Requests go to {base URL}/chat/completions. https only (plain http is allowed for localhost).">
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              unlockTouched();
            }}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            className="border-foreground/15 bg-background font-mono text-[13px]"
          />
        </Field>

        <Field
          label="API key"
          hint={
            provider?.hasKey && !clearKey ? (
              <>
                Saved{provider.keyHint ? <> ending <span className="font-mono">{provider.keyHint}</span></> : null}. Leave blank to keep it.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setClearKey(true)}>
                  Remove saved key
                </button>
              </>
            ) : clearKey ? (
              <>
                The saved key will be removed when you save.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setClearKey(false)}>
                  Undo
                </button>
              </>
            ) : provider?.keyUrl ? (
              <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                Get a key <ExternalLink className="size-3" />
              </a>
            ) : undefined
          }
        >
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                unlockTouched();
              }}
              placeholder={provider?.hasKey && !clearKey ? "••••••••••••••••" : "Paste your API key"}
              spellCheck={false}
              autoComplete="off"
              disabled={!secureStorage}
              className="border-foreground/15 bg-background pr-10 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide key" : "Show key"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <Field
          label="Automation model"
          hint={
            <>
              Used for every agent turn.{" "}
              {isNew ? "Session titles reuse this model." : (
                <>
                  Session titles are named automatically with <span className="font-mono">{provider.titleModel}</span>; that isn&apos;t configurable.
                </>
              )}
            </>
          }
        >
          <div className="flex gap-2">
            <Input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                unlockTouched();
              }}
              placeholder="model-name"
              spellCheck={false}
              autoComplete="off"
              className="border-foreground/15 bg-background font-mono text-[13px]"
            />
            <Button type="button" variant="outline" className="h-9 shrink-0 border-foreground/15" onClick={() => void browseModels()} disabled={models.phase === "loading" || !baseUrl.trim() || !hasUsableKey}>
              {models.phase === "loading" ? <Loader2 className="animate-spin" /> : <Search />}
              Browse
            </Button>
          </div>
        </Field>

        {models.phase === "error" && <p className="text-[13px] text-muted-foreground">{models.message}</p>}
        {models.phase === "done" && (
          <div className="rounded-lg border border-foreground/15 bg-background">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter ${models.models.length} models`}
                className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                autoFocus
              />
            </div>
            <ul className="max-h-52 overflow-y-auto py-1">
              {visibleModels.map((m) => (
                <li key={m}>
                  <button
                    type="button"
                    onClick={() => {
                      setModel(m);
                      setModels({ phase: "idle" });
                      unlockTouched();
                    }}
                    className={cn("block w-full truncate px-3 py-1.5 text-left font-mono text-[12px] hover:bg-accent", m === model && "text-foreground")}
                  >
                    {m}
                  </button>
                </li>
              ))}
              {visibleModels.length === 0 && <li className="px-3 py-2 text-[13px] text-muted-foreground">No models match.</li>}
              {models.models.length > MODEL_LIST_CAP && !filter && <li className="px-3 py-1.5 text-[12px] text-muted-foreground">Showing the first {MODEL_LIST_CAP}. Type to filter.</li>}
            </ul>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          {error}
        </div>
      )}

      {test.phase === "running" && (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Testing… some models take up to a minute to reply.
        </div>
      )}
      {test.phase === "done" && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] text-foreground",
            test.result.ok ? "border-status-idle/50 bg-status-idle/10" : "border-destructive/50 bg-destructive/10",
          )}
        >
          {test.result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-idle" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
          <span>{test.result.message}</span>
        </div>
      )}
      {test.phase === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          {test.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" variant="outline" className="border-foreground/15" onClick={() => void runTest()} disabled={test.phase === "running" || !hasUsableKey || !baseUrl.trim() || !model.trim()}>
          Test connection
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving || !dirty || (typedKey !== "" && !secureStorage)}>
          {saving && <Loader2 className="animate-spin" />}
          {isNew ? "Add provider" : "Save changes"}
        </Button>
        {provider && !provider.active && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void activate()}
            disabled={dirty || !provider.hasKey}
            title={dirty ? "Save your changes first" : !provider.hasKey ? "Add an API key first" : undefined}
          >
            Set as active
          </Button>
        )}
        {notice && !dirty && <span className="text-[13px] text-status-idle">{notice}</span>}
        <div className="ml-auto">
          {provider && provider.kind === "custom" && (
            <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void remove()} onBlur={() => setConfirmDelete(false)}>
              <Trash2 />
              {confirmDelete ? "Click again to delete" : "Delete"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
