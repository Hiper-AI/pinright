import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Every page of the site: one index.html per route, so Pages serves /evidence/ and friends as files. */
const pages = {
  home: 'index.html',
  evidence: 'evidence/index.html',
  install: 'install/index.html',
  security: 'security/index.html',
  faq: 'faq/index.html',
  notFound: '404.html',
};

/**
 * `<!-- @include header.html /evidence/ -->` inserts partials/header.html. The optional second
 * argument is the current route: the nav link with that href gets aria-current="page".
 */
function includes() {
  const pattern = /<!--\s*@include\s+([\w.-]+)(?:\s+(\S+))?\s*-->/g;
  return {
    name: 'pinright-includes',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(pattern, (_, file, current) => {
          let partial = fs.readFileSync(path.join(root, 'partials', file), 'utf8');
          if (current) partial = partial.replaceAll(`href="${current}"`, `href="${current}" aria-current="page"`);
          return partial;
        });
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
