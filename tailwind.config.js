/**
 * shadcn/ui v3-style token mapping. Colors read from CSS custom properties
 * defined in src/renderer/index.css (`:root` = light, `.dark` = dark) so the
 * theme toggle only ever needs to flip a class on <html> — no Tailwind
 * rebuild, no second source of truth.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Session-status dots only — independent of the neutral brand
        // palette above so status stays legible in both themes.
        status: {
          idle: "hsl(var(--status-idle))",
          running: "hsl(var(--status-running))",
          stopped: "hsl(var(--status-stopped))",
          created: "hsl(var(--status-created))",
        },

        // EchoAI-reference design-language tokens. These store complete CSS
        // color values (hex/rgba), not HSL triplets like the tokens above —
        // they don't need Tailwind's alpha-modifier trick, so there's no
        // reason to force them through hsl(). See index.css for values.
        "app-bg": "var(--bg-app)",
        panel: "var(--bg-panel)",
        "panel-border": "var(--panel-border)",
        elevated: "var(--bg-elevated)",
        "elevated-border": "var(--elevated-border)",
        square: "var(--square-bg)",
        "text-secondary": "var(--text-secondary)",
        brand: "var(--brand)",
        "brand-hover": "var(--brand-hover)",
        "brand-ring": "var(--brand-ring)",
        tooltip: "var(--tooltip-bg)",
        "tooltip-text": "var(--tooltip-text)",
        // Sidebar is a fixed dark palette regardless of theme (see
        // `.sidebar-scope` in index.css) — these are its own explicit,
        // precise tokens for the couple of spots the scoped shadcn
        // token overrides don't cover (the "Recent" label's third muted
        // tier, and the sidebar's exact translucent border).
        "sidebar-faint": "var(--sidebar-text-faint)",
        "sidebar-border": "var(--sidebar-border)",
        "sidebar-elevated": "var(--sidebar-elevated)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        // Geist — matches hellobonsai.com/partners/dribbble's design system
        // (see src/renderer/index.css for the self-hosted @font-face import).
        sans: ["Geist Sans", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        // Hero greeting only — a geometric sans distinct from the app's
        // Geist branding, per the reference design's headline treatment.
        hero: ["Inter", "Lato", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
