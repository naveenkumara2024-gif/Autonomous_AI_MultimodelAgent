/**
 * Tailwind CSS configuration — Autonomouse AI
 * ------------------------------------------
 * • content  → scans the `crt/` folder (your frontend / UI source)
 * • theme    → every value lives in the THEME SLOT below so you can
 *              re-theme the whole UI by editing exactly one section.
 * • darkMode → "class" (add `.dark` on your <html> tag to switch themes)
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",

  // ---------------------------------------------------------------
  // CONTENT ROOT — point this at whichever folder holds your UI.
  // Anything under ./crt that matches these extensions is scanned
  // for class names.
  // ---------------------------------------------------------------
  content: ["./src/**/*.{html,js,ts,jsx,tsx,vue,svelte}"],
  // If you ever move the frontend, just update the glob above.

  theme: {
    extend: {
      /* ========================================================== */
      /* ===================== THEME SLOT ========================= */
      /* ==== EDIT THIS SECTION ONLY TO RE-THEME THE UI =========== */
      /* ========================================================== */

      colors: {
        // -- Base surfaces (dark, near-black with subtle warmth) --
        base: {
          950: "#0a0a0f",
          900: "#111118",
          850: "#16161f",
          800: "#1c1c28",
          700: "#262636",
          600: "#34344a",
        },

        // -- Ink / text (name + soft + faint for hierarchy) -------
        ink: {
          DEFAULT: "#ececf5", // primary text
          soft: "#a6a6bd", // secondary text
          faint: "#6d6d85", // muted / placeholders
          inverse: "#0a0a0f", // text on light surfaces
        },

        // -- Accent (brand / AI "presence" color) -----------------
        accent: {
          DEFAULT: "#7c5cff", // primary interactive / AI
          soft: "#a58fff", // hover / highlights
          strong: "#5b3df0", // pressed / active
          glow: "#8f6bff", // radial glow accents
        },

        // -- Semantic status colors --------------------------------
        success: "#34d399",
        warning: "#fbbf24",
        danger: "#f87171",
        info: "#38bdf8",

        // -- Hairline borders / dividers ----------------------------
        border: {
          DEFAULT: "#262636",
          strong: "#34344a",
          faint: "#1c1c28",
        },
      },

      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["Space Grotesk", "Inter", "sans-serif"],
      },

      fontSize: {
        // Fluid UI scale tuned for an overlay / HUD style interface
        xs: ["0.7rem", { lineHeight: "1rem" }],
        sm: ["0.8rem", { lineHeight: "1.2rem" }],
        md: ["0.9rem", { lineHeight: "1.35rem" }],
        lg: ["1.05rem", { lineHeight: "1.5rem" }],
        xl: ["1.3rem", { lineHeight: "1.7rem" }],
      },

      borderRadius: {
        panel: "0.875rem", // main cards / dialogs
        chip: "9999px", // pills / tags
        control: "0.5rem", // inputs / buttons
      },

      boxShadow: {
        panel: "0 12px 40px rgb(0 0 0 / 0.5)",
        pop: "0 18px 60px rgb(0 0 0 / 0.6), 0 0 40px rgb(124 92 255 / 0.12)",
        glow: "0 0 24px rgb(124 92 255 / 0.4)",
        inset_faint: "inset 0 1px 0 rgb(255 255 255 / 0.04)",
      },

      backdropBlur: {
        hud: "24px",
      },

      animation: {
        "pulse-slow": "pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-up": "fadeUp 0.25s ease-out both",
        "sweep": "sweep 2.2s ease-in-out infinite",
      },

      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        sweep: {
          "0%, 100%": { transform: "translateX(-100%)" },
          "50%": { transform: "translateX(100%)" },
        },
      },

      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },

      /* ========================================================== */
      /* =================== END THEME SLOT ======================== */
      /* ========================================================== */
    },
  },

  plugins: [],
};