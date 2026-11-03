/**
 * Writes public/llms.txt and public/llms-full.txt for agents that read pinright.dev.
 *
 *   public/llms.txt        site/llms.txt, hand-written: what pinright is, install, tools, privacy, links
 *   public/llms-full.txt   the README and the main docs from the repository, concatenated, with the
 *                          relative GitHub links rewritten to absolute ones
 *
 * Runs from prepare-assets.mjs, so the full file never drifts from the docs it is built from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const out = path.join(site, 'public');
const BLOB = 'https://github.com/Hiper-AI/pinright/blob/main/';

const SOURCES = [
  ['README.md', 'README'],
  ['docs/how-it-works.md', 'How it works'],
  ['docs/hook.md', 'The pre-install hook'],
  ['docs/policy.md', 'Team policy (.pinright.json)'],
  ['docs/cli.md', 'CLI and configuration'],
  ['docs/install.md', 'Install: every client'],
];

/** Relative Markdown links (`](install.md#x)`, `](../bench/x.md)`) become absolute GitHub links. */
function absolutize(md, file) {
  const dir = path.posix.dirname(file);
  return md.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, target) => {
    const [p, hash] = target.split('#');
    const abs = path.posix.normalize(path.posix.join(dir, p));
    return `](${BLOB}${abs}${hash ? `#${hash}` : ''})`;
  });
}

const parts = [
  '# pinright: full documentation for agents',
  '',
  'Version-accurate docs and a dependency check for coding agents. This file concatenates the README and the main',
  'docs of https://github.com/Hiper-AI/pinright (MIT, by Hiper AI). Short version: https://pinright.dev/llms.txt',
  '',
];
for (const [file, title] of SOURCES) {
  const p = path.join(repo, file);
  if (!fs.existsSync(p)) {
    console.error(`llms: ${p} not found. Run from a pinright checkout.`);
    process.exit(1);
  }
  let md = fs.readFileSync(p, 'utf8');
  // The README opens with the cover picture, which says nothing to an agent.
  md = md.replace(/^<picture>[\s\S]*?<\/picture>\s*/m, '');
  parts.push('', '---', '', `<!-- ${file} -->`, '', `# ${title}`, '', absolutize(md, file).replace(/^# .*\n/, '').trim(), '');
}
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(site, 'llms.txt'), path.join(out, 'llms.txt'));
fs.writeFileSync(path.join(out, 'llms-full.txt'), parts.join('\n') + '\n');
console.log(`llms: public/llms.txt and public/llms-full.txt written (${SOURCES.length} sources)`);
