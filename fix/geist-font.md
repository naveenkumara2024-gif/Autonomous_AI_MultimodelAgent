# Fix: match the font used on hellobonsai.com/partners/dribbble

**Reported:** 2026-09-22 — user asked what font that page uses and wants the same one applied
here.

## What font it actually is

Fetched the page's shared CSS bundle
(`cdn.prod.website-files.com/.../css/hellobonsai.shared.*.min.css`, it's a Webflow site) and
checked the `@font-face` rules and `--fonts--*-font` custom properties directly, rather than
guessing from a screenshot: body, heading, and badge text all use a single family, **Geist**
(Vercel's open-source sans, OFL-1.1 licensed) — no separate mono/code font is set anywhere on that
page.

## How it's applied here

- Installed `@fontsource/geist-sans` (self-hosted static `.woff2` files, not a runtime CDN fetch —
  required, since `index.html`'s CSP is `default-src 'self'`, which would block any `@font-face`
  `url()` pointing at an external font CDN).
- [src/renderer/index.css](../src/renderer/index.css) — imports the `latin-400/500/600/700.css`
  weight files (covers `font-normal`/`font-medium`/`font-semibold`/bold usage across the app;
  skipped 100/200/300/800/900, which nothing here uses).
- [tailwind.config.js](../tailwind.config.js) — `fontFamily.sans` now leads with the font, falling
  back to the previous `Inter` stack if it somehow fails to load.

## Bug caught before shipping this

`@fontsource/geist-sans`'s `@font-face` rules register the family as **`'Geist Sans'`** (with a
space), not `Geist`. The first pass at `tailwind.config.js` used `"Geist"`, which doesn't match
that name — the browser would have silently fallen through to the `Inter` fallback and the font
change would have had zero visible effect. Caught by actually inspecting the compiled dev CSS
output (`dev:web`'s served `index.css`) rather than trusting the import alone; fixed to `"Geist
Sans"` to match the real declared family name.
