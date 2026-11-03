/**
 * Draws the README cover (assets/cover.svg, light and dark, plus PNG at 2x when a local Chrome or
 * Edge is found): the wordmark, the one-line promise and the real hook answer for
 * npm install lodash@4.17.20, taken from visuals/cli/hook-block.txt.
 *
 *   npx tsx paper/kit/make-cover.ts [--no-png]
 *
 * The mark is the provisional logo from site/partials/header.html.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AFTER, esc, MONO, type Mode, pngFromSvg, SANS, terminal, text, THEME } from './svg.js';

const here = import.meta.dirname;
const outDir = join(here, '..', '..', 'assets');
mkdirSync(outDir, { recursive: true });
const wantPng = !process.argv.includes('--no-png');

const W = 1280;
const H = 640;

function cover(mode: Mode): string {
  const t = THEME[mode];
  const accent = AFTER[mode];
  const msg = readFileSync(join(here, 'visuals', 'cli', 'hook-block.txt'), 'utf8').trimEnd().split('\n');
  const term = terminal({
    mode,
    cols: 66,
    title: 'Claude Code · PreToolUse · pinright hook',
    prompt: 'agent runs:',
    command: 'npm install lodash@4.17.20',
    lines: [...msg, '', '\x1b[90m(the command does not run)\x1b[39m'],
    highlight: (p) => (p.startsWith('pinright blocked') ? 'block' : undefined),
    desc: 'The hook answer for npm install lodash@4.17.20.',
  });
  const termX = W - term.w - 48;
  const termY = Math.round((H - term.h) / 2);

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  // A faint grid in the background, so the cover reads as a card on GitHub and on npmjs.com.
  parts.push(`<defs><pattern id="g-${mode}" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#g-${mode})"/>`);
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${t.border}"/>`);

  // Mark and wordmark.
  const mx = 72;
  const my = 150;
  parts.push(`<rect x="${mx}" y="${my}" width="56" height="56" rx="14" fill="${accent}"/>`);
  parts.push(`<circle cx="${mx + 28}" cy="${my + 21}" r="10" fill="${t.bg}"/>`);
  parts.push(`<rect x="${mx + 25.5}" y="${my + 28}" width="5" height="19" rx="2.5" fill="${t.bg}"/>`);
  parts.push(text(mx + 74, my + 44, 'pinright', { size: 54, weight: 700, fill: t.ink, font: MONO }));

  // Promise and the four shapes it ships in.
  const lines = ['Version-accurate docs and a', 'dependency check for coding agents.'];
  lines.forEach((l, i) => parts.push(text(mx, my + 120 + i * 40, l, { size: 30, weight: 600, fill: t.ink, font: SANS })));
  parts.push(text(mx, my + 228, 'The agent gets docs for the exact version it installs, and a verdict', { size: 17, fill: t.ink2 }));
  parts.push(text(mx, my + 254, 'on every dependency it adds, before the install runs.', { size: 17, fill: t.ink2 }));
  const chips = ['MCP server', 'pre-install hook', 'CLI', 'GitHub Action', 'MIT'];
  let cx = mx;
  for (const c of chips) {
    const w = Math.round(c.length * 7.6 + 24);
    parts.push(`<rect x="${cx}" y="${my + 292}" width="${w}" height="30" rx="15" fill="${t.term}" stroke="${t.axis}"/>`);
    parts.push(text(cx + w / 2, my + 312, c, { size: 13, fill: t.ink2, anchor: 'middle', font: MONO }));
    cx += w + 10;
  }

  // The hook answer, as the agent sees it.
  parts.push(`<svg x="${termX}" y="${termY}" width="${term.w}" height="${term.h}" viewBox="0 0 ${term.w} ${term.h}">${term.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</svg>`);

  const title = 'pinright: version-accurate docs and a dependency check for coding agents';
  const desc = 'Cover with the pinright wordmark, the promise, and the real hook answer for npm install lodash@4.17.20: pinright blocked this dependency change; lodash 4.17.20 has 5 known advisories; use 4.x release 4.18.1.';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${parts.join('\n')}
</svg>
`;
}

for (const mode of ['light', 'dark'] as Mode[]) {
  const base = mode === 'light' ? 'cover' : 'cover-dark';
  const svgPath = join(outDir, `${base}.svg`);
  writeFileSync(svgPath, cover(mode));
  console.log(`wrote assets/${base}.svg`);
  if (wantPng) {
    if (pngFromSvg(svgPath, join(outDir, `${base}.png`), W, H)) console.log(`wrote assets/${base}.png`);
    else console.warn(`no PNG for ${base}: no local Chrome or Edge (set PINRIGHT_KIT_BROWSER)`);
  }
}
