import { KeyRound, Plus } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ProviderPublic } from "../../types";
import { Pill } from "./primitives";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ProviderCard({ provider, selected, onSelect }: { provider: ProviderPublic; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex min-h-[92px] flex-col items-start gap-2 rounded-lg border bg-background p-3.5 text-left transition-colors",
        "hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring",
        selected ? "border-foreground/60 ring-1 ring-foreground/20" : "border-border",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{provider.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{hostOf(provider.baseUrl)}</div>
        </div>
        {provider.active && <Pill tone="active">Active</Pill>}
      </div>
      <div className="mt-auto flex w-full items-center justify-between gap-2 text-[12px]">
        <span className="truncate font-mono text-muted-foreground">{provider.model || "no model set"}</span>
        <span className={cn("flex shrink-0 items-center gap-1", provider.hasKey ? "text-status-idle" : "text-muted-foreground")}>
          <KeyRound className="size-3" />
          {provider.hasKey ? "Key saved" : "No key"}
        </span>
      </div>
    </button>
  );
}

export function AddProviderCard({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-transparent p-3.5 text-muted-foreground transition-colors",
        "hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring",
        selected ? "border-foreground/60 text-foreground" : "border-border",
      )}
    >
      <Plus className="size-4" />
      <span className="text-[13px] font-medium">Add custom provider</span>
    </button>
  );
}
