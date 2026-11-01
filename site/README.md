# pinright.dev

The website for pinright. Static HTML and CSS built with [Vite](https://vite.dev), one small script
(theme toggle and copy buttons), no framework, no web fonts, no trackers, no cookies. It is its own
package with its own lockfile and is not part of the npm package (`files` in the root `package.json`
and `scripts/check-pack.mjs` keep it out of the tarball; the root ESLint config ignores it).

## Run it

Node 20.19 or newer.

```bash
cd site
npm ci
npm run dev       # http://localhost:4320, with live reload
npm run build     # dist/, then scripts/check-dist.mjs
npm run preview   # serves dist/ at http://localhost:4321
```

## Where things live

| Path | What |
|---|---|
| `index.html`, `evidence/`, `install/`, `security/`, `faq/`, `404.html` | One HTML file per route |
| `partials/` | Head, header and footer, inserted by the `<!-- @include file -->` plugin in `vite.config.mjs` |
| `src/styles.css`, `src/main.js` | All the CSS and the only script |
| `public/` | Files served as they are: `_headers` (CSP and other headers for Cloudflare Pages), `robots.txt`, `sitemap.xml`, favicons, `og.png`, `theme-init.js` |
| `scripts/prepare-assets.mjs` | Copies the launch-kit figures and the report before dev and build |
| `scripts/check-dist.mjs` | Fails the build on a broken internal link or anchor, an inline script or style the CSP would block, an em dash or a word the launch copy rules out |
| `scripts/og-card.html` | Source of `public/og.png` (1200x630) |

## Figures and the technical report

The figures come from `paper/kit/figures/` and are copied to `public/kit/` on every dev and build, so
the site never keeps a second copy in git. Regenerate them in the kit (`npx tsx paper/kit/make-figures.ts`),
not here.

`/report.pdf` is `paper/kit/pinright-report.pdf`, which is gitignored in this repository. Build it
first from the repository root:

```bash
node paper/build-pdf.mjs --css paper/kit/pdf.css paper/kit/pinright-report.md
```

`npm run build` fails when the PDF is missing, so a deploy cannot ship a dead link.
`PINRIGHT_SITE_NO_REPORT=1 npm run build` builds without it on purpose.

## Copy rules

Every number on the site comes from `paper/kit/claims.md`. Keep the qualifier next to each number
(three models of one vendor, 12 tasks we wrote, advisory data from 2026-11-01), show the docs-only
ablation next to the headline, and write "pinright" in lowercase everywhere. `check-dist.mjs`
rejects em dashes and absolute words ("secure", "guarantee", "eliminate", "100%", compliance terms).

## Images

`public/og.png`, `favicon-32.png` and `apple-touch-icon.png` are screenshots of
`scripts/og-card.html` and `public/favicon.svg` taken with headless Chrome at 1x. Re-render them
after changing either source.

## Deploy

Cloudflare Pages, static output: build command `npm ci && npm run build` with root directory
`site`, output directory `dist`, `NODE_VERSION=22`. Because the report PDF is not in git, either
deploy with Direct Upload from a machine that has built it
(`npx wrangler pages deploy dist --project-name pinright-site`), or publish the PDF somewhere the
build can fetch it. Nothing is deployed from this folder automatically.
