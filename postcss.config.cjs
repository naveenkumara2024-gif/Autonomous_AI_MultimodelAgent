/**
 * PostCSS configuration — Autonomouse AI
 * --------------------------------------
 * Named `.cjs` so it loads reliably even though package.json
 * declares `"type": "module"`. Wire this into your bundler:
 *  - Vite:  it is picked up automatically from the project root
 *  - CLI:   npx tailwindcss -i ./crt/style.css -o ./crt/out.css
 */
module.exports = {
  plugins: {
    // Tailwind v3 (config-driven, tailwind.config.js)
    tailwindcss: {},
    autoprefixer: {},
  },
};