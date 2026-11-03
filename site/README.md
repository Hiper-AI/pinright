# pinright.dev

The website for pinright, in English and Spanish. Static HTML and CSS built with [Vite](https://vite.dev), one small script
(theme toggle, copy buttons, language switcher), no framework, no web fonts, no trackers, no cookies. It is its own
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
| `index.html`, `evidence/`, `install/`, `security/`, `faq/`, `404.html` | One HTML file per route, in English |
| `es/` | The same pages in Spanish, same slugs (`es/index.html`, `es/evidence/index.html`, ...) |
| `partials/` | Head, header, footer, the lockups and the large icons, inserted by the `<!-- @include file -->` plugin in `vite.config.mjs`; `*.es.html` are the Spanish variants |
| `src/styles.css`, `src/main.js` | All the CSS and the entry script (theme toggle, copy buttons), which imports `story.js`, `footer.js`, `header.js`, `lang.js` (language switcher) and `i18n.js` (script strings) |
| `public/` | Files served as they are: `_headers` (CSP and other headers for Cloudflare Pages), `robots.txt`, `sitemap.xml`, favicons, `og.png`, `og-es.png`, `theme-init.js` |
| `scripts/prepare-assets.mjs` | Copies the launch-kit figures and the report before dev and build, and runs `scripts/llms.mjs` |
| `llms.txt`, `scripts/llms.mjs` | `/llms.txt` (hand-written, for agents) and `/llms-full.txt` (the README and the main docs concatenated, built on every dev and build) |
| `scripts/check-dist.mjs` | Fails the build on a broken internal link or anchor, an inline script or style the CSP would block, an em dash or a word the launch copy rules out |
| `scripts/og-card.html`, `scripts/og-card.es.html` | Sources of `public/og.png` and `public/og-es.png` (1200x630), rendered by `scripts/render-og.mjs` |

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
(three models of one vendor, 12 tasks we wrote, advisory data from 2026-11-02 and 2026-11-03, benchmark v7 on the 1.0.0 code), show the docs-only
ablation next to the headline, and write "pinright" in lowercase everywhere. `check-dist.mjs`
rejects em dashes and absolute words ("secure", "guarantee", "eliminate", "100%", compliance terms),
and their Spanish counterparts on the pages under `es/` (see "Spanish style" below).

## Images

`public/og.png`, `favicon-32.png` and `apple-touch-icon.png` are screenshots of
`scripts/og-card.html` and `public/favicon.svg` taken with headless Chrome at 1x. Re-render them
after changing either source.

`public/og-es.png` is the card of the Spanish pages, from `scripts/og-card.es.html` (same style;
the terminal lines stay in English because they are the hook's real output). Both cards render
with `scripts/render-og.mjs`, which uses Playwright and the local Chrome. Playwright is not a
dependency of the site, so pass a `package.json` that has it:

```bash
node scripts/render-og.mjs ../../secureai/qa/package.json      # both cards
node scripts/render-og.mjs ../../secureai/qa/package.json es   # only og-es.png
```

## Languages: English and Spanish

English lives at `/` and Spanish at `/es/`, with the same slugs (`/install/` and `/es/install/`),
so every page maps 1:1 to its counterpart. There is one `404.html`, in English with a Spanish line
and a link to `/es/`, because Pages serves a single 404 page. `llms.txt` and `llms-full.txt` stay
English only.

**Pages.** A Spanish page is `es/<route>/index.html`, registered in `vite.config.mjs` together with
its English page (the `routes` list builds both). It sets `<html lang="es">`, its own title,
description, `og:*` and `twitter:*` text, and a canonical and `og:url` under `/es/`. Links inside a
Spanish page point at Spanish pages; links to the report PDF and to GitHub files stay as they are
and say "(en inglés)" where it helps.

**Partials.** `<!-- @include header.html /es/install/ -->` on a page under `es/` inserts
`partials/header.es.html` when that file exists, and `partials/header.html` otherwise. A partial
with text has an `.es.html` variant (head, header, footer, every chart); one without text (the
lockups, the icons) has one file. Partials can include partials. Inside a partial, `{{en}}`,
`{{es}}` and `{{alt}}` become this page's path in English, in Spanish and in the other language,
and `<!-- @alternates -->` becomes the three `hreflang` links (`en`, `es`, `x-default` = English).
The header's language switcher links to `{{alt}}`; `src/lang.js` adds the `#hash` and remembers
the choice in `localStorage` (`pinright-lang`). Nothing redirects on that choice.

**Script strings.** Every string a script writes or announces (copy button, status messages, the
theme toggle's label) is in `src/i18n.js`, keyed by `<html lang>`. Add a key to both `en` and `es`.
The theme toggle's first label is also in each header partial, for the page before the script runs.

**Charts.** `scripts/charts.mjs` writes every chart twice, `chart-x.html` and `chart-x.es.html`,
from the same CSVs; the words are in its `LANGS` table. The numbers in the charts follow the CSVs
on their own. The numbers in the page text and tables are typed by hand in both languages: when an
English number changes, change the Spanish page too.

**Checks.** `check-dist.mjs` fails the build when a page lacks its counterpart, when the `hreflang`
links are not reciprocal, when `<html lang>`, canonical, `og:url`, `og:locale` or `og:image` do not
match the page, when a placeholder was not expanded, and on the copy rules below for both languages.

**`og:locale`.** `es_419` (Spanish, Latin America and the Caribbean) on Spanish pages, with `en_US`
as `og:locale:alternate`, and the reverse on English pages. The copy is neutral Latin American
Spanish with "tú", so a single country (`es_AR`) would claim more than the text does, and `es_ES`
would be wrong.

### Spanish style

- Register: "tú" (puedes, ejecuta, revisa), as on hiperai.com; no voseo. Short active sentences.
- Same copy rules as English, plus: no "garantiza/garantía", "elimina", "certificado",
  "seguro/segura" (as a promise; rephrase "sure" too), no "100%". No filler ("realmente",
  "simplemente", "básicamente", "en definitiva"), no "no es X, es Y", no em dashes.
- Never name another docs product or company.
- Code, commands, package names, versions, CVE ids, tool names (get-docs, check-packages) and model
  names stay as they are, and so does real tool output (the hook text in the story, the get-docs
  answer): the caption says it is in English.

**Numbers.** Decimal comma: `0,3`, `29,8`, `2,4 s`, `USD 35,10`. Thousands with a point: `25.077`,
`154.402`. Percent sign with no space, like the English pages, so it never wraps away from its
number in a chip, a cell or a chart label: `40%`, `1,46%`. Ranges with "a": `40% a 42%`, `9 a 14 de
16`; counts with "de": `16 de 16`. Intervals in brackets with a semicolon, since the comma is the
decimal mark: `[47,2; 63,5]`, `24% [14; 34]`. `k` for thousands of tokens stays (`55,6k`), and so
does `x` for multiples (`1,5x`) and for "12 tareas x 2 ejecuciones". Versions keep their dots
(`Node 20.9`, `1.0.0`, `AI SDK 5/6`). Dates stay ISO (`2026-11-02`).

### Glossary

| English | Spanish |
|---|---|
| advisory, known advisory | aviso de seguridad, aviso de seguridad conocido (short: aviso) |
| verdict | veredicto |
| pin (a version), pinned | fijar (una versión), fijada |
| release line | línea de versiones |
| release (a published version) | versión; "release" only in "tag de release" and "runner de releases" |
| major (version) | versión mayor |
| hook, pre-install hook | hook, hook de preinstalación |
| MCP server | servidor MCP |
| docs, docs-only, no docs | docs / documentación, solo docs, sin docs |
| docs-only context server | servidor de contexto solo docs |
| lockfile, manifest | lockfile, manifiesto |
| whole-tree alerts | alertas en todo el árbol |
| direct dependency | dependencia directa |
| lookalike names | nombres parecidos |
| malware records | registros de malware |
| run (benchmark), arm | ejecución, brazo |
| task, turn | tarea, turno |
| 95% interval | intervalo del 95% |
| smoke test | prueba de humo |
| shell | shell |
| registry | registro |
| fix (an advisory fix) | arreglo |
| false positive | falso positivo |
| guardrail, sandbox | barrera de protección, sandbox |
| threat model | modelo de amenazas |
| prompt injection | inyección de prompts |
| fence (`<untrusted-data>`) | delimitador |
| supply chain | cadena de suministro |
| policy (`.pinright.json`) | política |
| release candidate | versión candidata |
| tool call | llamada a herramienta |
| cache, warm, cold | caché, caliente, en frío |
| technical report | informe técnico |
| caveats | salvedades |

## Deploy

Cloudflare Pages, static output: build command `npm ci && npm run build` with root directory
`site`, output directory `dist`, `NODE_VERSION=22`. Because the report PDF is not in git, either
deploy with Direct Upload from a machine that has built it
(`npx wrangler pages deploy dist --project-name pinright-site`), or publish the PDF somewhere the
build can fetch it. Nothing is deployed from this folder automatically.
