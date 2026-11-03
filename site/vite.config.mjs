import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://pinright.dev';

/**
 * Every page of the site: one index.html per route, so Pages serves /evidence/ and friends as files.
 * English lives at the root and Spanish under es/, with the same slugs, so each page maps 1:1 to its
 * counterpart. There is one 404.html (Pages serves only that one), in English with a Spanish line.
 */
const routes = ['', 'evidence/', 'install/', 'security/', 'faq/'];
const pages = { notFound: '404.html' };
for (const r of routes) {
  const name = r ? r.slice(0, -1) : 'home';
  pages[name] = `${r}index.html`;
  pages[`es-${name}`] = `es/${r}index.html`;
}

/** Language and route of a page file: es/install/index.html is { lang: 'es', route: 'install/' }. */
function pageOf(filename) {
  const rel = path.relative(root, filename).replace(/\\/g, '/');
  const lang = rel.startsWith('es/') ? 'es' : 'en';
  const inner = lang === 'es' ? rel.slice(3) : rel;
  const route = inner.endsWith('index.html') ? inner.slice(0, -'index.html'.length) : null;
  return { lang, route };
}

/**
 * `<!-- @include header.html /evidence/ -->` inserts partials/header.html. The optional second
 * argument is the current route: the nav link with that href gets aria-current="page".
 *
 * Language: a page under es/ gets partials/<name>.es.html when that file exists, and the plain
 * partial otherwise (the lockups and icons have no text, so they have one file). Partials can
 * include other partials. Inside a partial, {{en}} and {{es}} are the URL paths of this page in
 * each language, {{alt}} the path in the other language, and <!-- @alternates --> becomes the
 * hreflang links (nothing on the 404 page, which has no counterpart).
 */
function includes() {
  const pattern = /<!--\s*@include\s+([\w.-]+)(?:\s+(\S+))?\s*-->/g;
  const expand = (html, page, depth) => {
    if (depth > 4) throw new Error('pinright-includes: partials nested too deep');
    return html.replace(pattern, (_, file, current) => {
      const localized = file.replace(/\.html$/, `.${page.lang}.html`);
      const pick = page.lang !== 'en' && fs.existsSync(path.join(root, 'partials', localized)) ? localized : file;
      let partial = fs.readFileSync(path.join(root, 'partials', pick), 'utf8');
      partial = expand(partial, page, depth + 1);
      const en = `/${page.route ?? ''}`;
      const es = `/es/${page.route ?? ''}`;
      const alternates = page.route == null ? '' : [
        `<link rel="alternate" hreflang="en" href="${ORIGIN}${en}">`,
        `<link rel="alternate" hreflang="es" href="${ORIGIN}${es}">`,
        `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${en}">`,
      ].join('\n    ');
      partial = partial
        .replaceAll('{{en}}', en)
        .replaceAll('{{es}}', es)
        .replaceAll('{{alt}}', page.lang === 'es' ? en : es)
        .replace(/( *)<!-- @alternates -->\n?/, (_, indent) => (alternates ? `${indent}${alternates}\n` : ''));
      if (current) partial = partial.replaceAll(`href="${current}"`, `href="${current}" aria-current="page"`);
      return partial;
    });
  };
  return {
    name: 'pinright-includes',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return expand(html, pageOf(ctx.filename), 0);
      },
    },
  };
}

export default defineConfig({
  appType: 'mpa',
  plugins: [includes()],
  server: { watch: { ignored: ['**/public/kit/**'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No inline polyfill script: the CSP in public/_headers allows scripts from 'self' only.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, path.join(root, v)])),
    },
  },
});
