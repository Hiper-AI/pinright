/**
 * Checks the built site in dist/ before a deploy:
 *   - every internal href/src points at a file in dist/ (and every #fragment at an id on that page);
 *   - no inline <script> or style="" attribute, which the CSP in public/_headers would block;
 *   - no em dash and none of the words the launch copy rules out, in the visible text.
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

for (const file of html) {
  const rel = path.relative(dist, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(m[1]) && m[2].trim()) problems.push(`${rel}: inline <script> (blocked by the CSP)`);
  }
  if (/<style\b/.test(text)) problems.push(`${rel}: inline <style> (blocked by the CSP)`);
  if (/\sstyle="/.test(text)) problems.push(`${rel}: style="" attribute (blocked by the CSP)`);

  for (const m of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:)/.test(url)) continue;
    const [urlPath, fragment] = url.split('#');
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
  for (const [re, what] of banned) {
    const where = re.exec(visible) ? 'text' : re.exec(attrs) ? 'attribute' : null;
    if (where) problems.push(`${rel}: ${what} in ${where}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-dist: ${html.length} pages, ${files.length} files, links and copy rules ok`);
