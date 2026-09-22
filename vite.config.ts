import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `--mode web` (see package.json's "dev:web") serves only the renderer in a
// regular browser tab, for quick UI/styling iteration — no Electron process,
// no IPC bridge. window.agentBridge is unavailable there; App.tsx detects
// that and shows a notice instead of pretending session data exists.
export default defineConfig(({ mode }) => ({
  root: path.join(__dirname, "src/renderer"),
  resolve: {
    alias: {
      "@": path.join(__dirname, "src"),
      "@main": path.join(__dirname, "src/main"),
      "@renderer": path.join(__dirname, "src/renderer"),
    },
  },
  plugins: [
    react(),
    ...(mode === "web"
      ? []
      : [
          electron({
            main: {
              entry: path.join(__dirname, "src/main/index.ts"),
              vite: {
                build: {
                  outDir: path.join(__dirname, "dist-electron/main"),
                  rollupOptions: {
                    external: ["electron"],
                  },
                },
              },
            },
            preload: {
              input: path.join(__dirname, "src/preload/index.ts"),
              vite: {
                build: {
                  outDir: path.join(__dirname, "dist-electron/preload"),
                  rollupOptions: {
                    external: ["electron"],
                  },
                },
              },
            },
          }),
        ]),
  ],
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
  },
}));
