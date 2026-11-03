/**
 * Checks the built site in dist/ before a deploy:
 *   - every internal href/src points at a file in dist/ (and every #fragment at an id on that page);
 *   - no inline <script> or style="" attribute, which the CSP in public/_headers would block;
 *   - no em dash and none of the words the launch copy rules out, in the visible text, with a
 *     Spanish list on top for the pages under es/;
 *   - each page's <html lang>, canonical, og:url, og:locale and og:image match its language and
 *     path, and every page has its counterpart in the other language with reciprocal hreflang links.
 * Exit 1 on any problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!fs.existsSync(dist)) {
  console.error('check-dist: dist/ not found; run npm run build');
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

const html = files.filter((f) => f.endsWith('.html'));
const problems = [];
const ids = new Map();

function idsOf(file) {
  if (!ids.has(file)) {
    const text = fs.readFileSync(file, 'utf8');
    ids.set(file, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
}

function resolveTarget(urlPath) {
  const clean = decodeURIComponent(urlPath);
  const candidates = clean.endsWith('/') ? [path.join(dist, clean, 'index.html')] : [path.join(dist, clean), path.join(dist, clean, 'index.html')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

const banned = [
  [/—/, 'em dash'],
  [/\bsecure\b/i, '"secure"'],
  [/\b100\s?%/, '"100%"'],
  [/\bguarantee/i, '"guarantee"'],
  [/\beliminat/i, '"eliminate"'],
  [/\bcertified\b|\bcompliant\b/i, 'compliance language'],
];

/** The same rules for the Spanish pages, on top of the English list: no promise of safety or compliance. */
const bannedEs = [
  [/\bgarantiz/i, '"garantiz*"'],
  [/\bgarant[ií]a/i, '"garantía"'],
  [/\belimin/i, '"elimin*"'],
  [/\bcertificad/i, '"certificad*"'],
  [/\bsegur[oa]s?\b/i, '"seguro/segura"'],
];

const ORIGIN = 'https://pinright.dev';
const meta = (text, attr, name) => text.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
const hreflangs = (text) => Object.fromEntries([...text.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
const pages = new Map();

for (const file of html) {
  const rel = path.relative(dist, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  // Language: pages under es/ are Spanish, everything else English. One 404.html for both.
  const lang = rel.startsWith('es/') ? 'es' : 'en';
  const htmlLang = text.match(/<html lang="([^"]+)"/)?.[1];
  if (htmlLang !== lang) problems.push(`${rel}: <html lang="${htmlLang}">, expected "${lang}"`);
  if (/\{\{(?:en|es|alt)\}\}|@include|@alternates/.test(text)) problems.push(`${rel}: an include or placeholder was not expanded`);
  if (rel !== '404.html') {
    const url = `${ORIGIN}/${rel.replace(/index\.html$/, '')}`;
    const canonical = text.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
    if (canonical !== url) problems.push(`${rel}: canonical ${canonical}, expected ${url}`);
    if (meta(text, 'property', 'og:url') !== url) problems.push(`${rel}: og:url does not match the canonical`);
    const locale = lang === 'es' ? 'es_419' : 'en_US';
    if (meta(text, 'property', 'og:locale') !== locale) problems.push(`${rel}: og:locale is not ${locale}`);
    const image = meta(text, 'property', 'og:image');
    const expectImage = `${ORIGIN}/${lang === 'es' ? 'og-es.png' : 'og.png'}`;
    if (image !== expectImage) problems.push(`${rel}: og:image ${image}, expected ${expectImage}`);
    else if (!fs.existsSync(path.join(dist, image.slice(ORIGIN.length + 1)))) problems.push(`${rel}: og:image file missing in dist/`);
    pages.set(url, { rel, lang, alt: hreflangs(text) });
  }

  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(m[1]) && m[2].trim()) problems.push(`${rel}: inline <script> (blocked by the CSP)`);
  }
  if (/<style\b/.test(text)) problems.push(`${rel}: inline <style> (blocked by the CSP)`);
  if (/\sstyle="/.test(text)) problems.push(`${rel}: style="" attribute (blocked by the CSP)`);

  for (const m of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:)/.test(url)) continue;
    const [withQuery, fragment] = url.split('#');
    const urlPath = withQuery.split('?')[0];
    const target = urlPath ? resolveTarget(urlPath.startsWith('/') ? urlPath : `/${path.posix.join(path.posix.dirname(rel), urlPath)}`) : file;
    if (!target) {
      problems.push(`${rel}: broken link ${url}`);
      continue;
    }
    if (fragment && target.endsWith('.html') && !idsOf(target).has(fragment)) problems.push(`${rel}: missing anchor ${url}`);
  }

  const visible = text
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<(?:pre|code)\b[\s\S]*?<\/(?:pre|code)>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const attrs = [...text.matchAll(/\s(?:alt|content|aria-label|title)="([^"]*)"/g)].map((m) => m[1]).join(' ');
  for (const [re, what] of lang === 'es' ? [...banned, ...bannedEs] : banned) {
    const where = re.exec(visible) ? 'text' : re.exec(attrs) ? 'attribute' : null;
    if (where) problems.push(`${rel}: ${what} in ${where}`);
  }
}

// Every page has its counterpart in the other language, and the hreflang links agree both ways:
// each page names itself and its counterpart, x-default is the English page, and the counterpart
// names this page back.
for (const [url, page] of pages) {
  const en = page.lang === 'en' ? url : url.replace(`${ORIGIN}/es/`, `${ORIGIN}/`);
  const es = page.lang === 'es' ? url : url.replace(`${ORIGIN}/`, `${ORIGIN}/es/`);
  const other = page.lang === 'en' ? es : en;
  if (!pages.has(other)) {
    problems.push(`${page.rel}: no counterpart page at ${other}`);
    continue;
  }
  const want = { en, es, 'x-default': en };
  for (const [hl, href] of Object.entries(want)) {
    if (page.alt[hl] !== href) problems.push(`${page.rel}: hreflang="${hl}" is ${page.alt[hl]}, expected ${href}`);
  }
  if (Object.keys(page.alt).length !== 3) problems.push(`${page.rel}: expected 3 hreflang links, found ${Object.keys(page.alt).length}`);
  const back = pages.get(other).alt[page.lang];
  if (back !== url) problems.push(`${page.rel}: ${pages.get(other).rel} does not point back with hreflang="${page.lang}"`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-dist: ${html.length} pages, ${files.length} files, links and copy rules ok`);
