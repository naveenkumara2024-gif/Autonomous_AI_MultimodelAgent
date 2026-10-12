import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** A titled card of settings rows. */
export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{description}</p>}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** Label + description on the left, the control on the right. */
export function SettingRow({
  label,
  description,
  children,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 px-5 py-3.5", disabled && "opacity-50")}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A labelled form field (stacked). */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A small status pill. */
export function Pill({ tone, children }: { tone: "active" | "ok" | "muted" | "warn"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "active" && "border-brand/40 bg-brand/15 text-foreground",
        tone === "ok" && "border-status-idle/40 text-status-idle",
        tone === "warn" && "border-status-stopped/50 text-status-stopped",
        tone === "muted" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
