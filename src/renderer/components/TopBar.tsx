import { Moon, Sparkles, Sun, UserRound, Zap } from "lucide-react";
import type { BackgroundEffect } from "../hooks/useBackgroundEffect";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface TopBarProps {
  title: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  backgroundEffect: BackgroundEffect;
  onToggleBackgroundEffect: () => void;
}

export function TopBar({
  title,
  theme,
  onToggleTheme,
  backgroundEffect,
  onToggleBackgroundEffect,
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
      <span className="truncate text-sm font-medium text-foreground">{title}</span>

      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2">
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
