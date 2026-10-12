import { Moon, Settings, Sparkles, Sun, UserRound, Zap } from "lucide-react";
import type { BackgroundEffect } from "../hooks/useBackgroundEffect";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface TopBarProps {
  title: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  backgroundEffect: BackgroundEffect;
  onToggleBackgroundEffect: () => void;
  /** The provider + model the agent will use now; null when nothing usable is configured yet. */
  activeModel: { providerName: string; model: string } | null;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}

export function TopBar({
  title,
  theme,
  onToggleTheme,
  backgroundEffect,
  onToggleBackgroundEffect,
  activeModel,
  settingsOpen,
  onOpenSettings,
}: TopBarProps) {
  // Reference design's small elevated square: visible bg/border/shadow at
  // rest (not just on hover, unlike Button's plain "ghost" variant), soft
  // shadow in light theme only.
  const iconButtonClass =
    "h-9 w-9 rounded-[10px] border border-elevated-border bg-elevated shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:bg-elevated dark:shadow-none transition-surface";

  return (
    // relative z-10: the idle-page background effect (Side Rays / Aero
    // Shards) is an absolutely-positioned sibling one level up. Without its
    // own stacking context, TopBar's un-positioned content paints *behind*
    // that positioned layer per normal CSS stacking order — invisible under
    // Aero Shards specifically, since unlike Side Rays' transparent canvas,
    // its background is fully opaque.
    <div className="relative z-10 flex items-center justify-between px-6 py-5">
      {/* key={title}: remounts the span whenever the title text changes
          (truncated fallback -> AI-refined title, or a manual rename), so
          the fade-in below replays instead of the text just snapping. */}
      <span
        key={title}
        className="truncate text-sm font-medium text-foreground animate-in fade-in-0 duration-300"
      >
        {title}
      </span>

      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2">
          {/* The model in use, never a mystery. Opens Settings. */}
          <button
            type="button"
            onClick={onOpenSettings}
            title={activeModel ? `${activeModel.model} via ${activeModel.providerName}` : "No model provider is set up — open Settings"}
            className="flex h-9 max-w-[260px] items-center gap-2 rounded-[10px] border border-elevated-border bg-elevated px-3 text-[12px] transition-surface hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", activeModel ? "bg-status-idle" : "bg-status-stopped")} />
            {activeModel ? (
              <span className="truncate">
                <span className="font-mono text-foreground">{activeModel.model}</span>
                <span className="ml-1.5 text-muted-foreground">{activeModel.providerName}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">Set up a provider</span>
            )}
          </button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                onClick={onToggleTheme}
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              >
                {theme === "dark" ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{theme === "dark" ? "Light theme" : "Dark theme"}</TooltipContent>
          </Tooltip>

          {/* Idle-page decorative background — only meaningful in dark mode,
              since that's the only theme either effect renders in. */}
          {theme === "dark" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={iconButtonClass}
                  onClick={onToggleBackgroundEffect}
                  aria-label={
                    backgroundEffect === "rays" ? "Switch to Aero Shards background" : "Switch to Side Rays background"
                  }
                >
                  {backgroundEffect === "rays" ? <Sparkles /> : <Zap />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{backgroundEffect === "rays" ? "Aero Shards" : "Side Rays"}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(iconButtonClass, settingsOpen && "border-foreground/40")}
                onClick={onOpenSettings}
                aria-label="Settings"
                aria-pressed={settingsOpen}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              {/* Guest placeholder — swap for the real account/profile control once auth exists. */}
              <Button type="button" variant="ghost" size="icon" className={iconButtonClass} aria-label="Guest">
                <UserRound />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Guest</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
