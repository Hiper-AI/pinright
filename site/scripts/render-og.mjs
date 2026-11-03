/**
 * Renders the social cards: scripts/og-card.html to public/og.png and scripts/og-card.es.html to
 * public/og-es.png, both 1200x630 at 1x, with Playwright and the local Chrome. Playwright is not a
 * dependency of the site: pass the path of a package.json that has it, or set PINRIGHT_PLAYWRIGHT.
 *
 *   node scripts/render-og.mjs [path/to/package.json-with-playwright] [en|es]
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = process.argv[2] || process.env.PINRIGHT_PLAYWRIGHT;
if (!from) {
  console.error('render-og: pass the path of a package.json that depends on playwright');
  process.exit(2);
}
const { chromium } = createRequire(path.resolve(from))('playwright');
const only = process.argv[3];
const cards = [
  ['en', 'og-card.html', 'og.png'],
  ['es', 'og-card.es.html', 'og-es.png'],
].filter(([lang]) => !only || lang === only);

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const [, source, out] of cards) {
    await page.goto(pathToFileURL(path.join(site, 'scripts', source)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(site, 'public', out) });
    console.log(`render-og: public/${out}`);
  }
} finally {
  await browser.close();
}
