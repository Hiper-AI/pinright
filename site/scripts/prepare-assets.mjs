/**
 * Copies the launch-kit figures and the technical report from ../paper/kit into public/ before
 * dev and build, so the site never keeps a second copy of them in git.
 *
 *   public/kit/<figure>.svg   light and dark SVGs of every figure in paper/kit/figures
 *   public/report.pdf         paper/kit/pinright-report.pdf (gitignored in the repo: build it first)
 *
 * With --strict (npm run build) a missing report fails the build, so a deploy cannot ship a dead
 * /report.pdf link. PINRIGHT_SITE_NO_REPORT=1 skips it on purpose (the link then 404s).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.resolve(site, '..', 'paper', 'kit');
const strict = process.argv.includes('--strict');
const out = path.join(site, 'public', 'kit');

const figures = path.join(kit, 'figures');
if (!fs.existsSync(figures)) {
  console.error(`prepare-assets: ${figures} not found. Run from a pinright checkout.`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let count = 0;
for (const name of fs.readdirSync(figures)) {
  if (!name.endsWith('.svg')) continue;
  fs.copyFileSync(path.join(figures, name), path.join(out, name));
  count++;
}
console.log(`prepare-assets: ${count} figures copied to public/kit/`);

const report = path.join(kit, 'pinright-report.pdf');
const target = path.join(site, 'public', 'report.pdf');
if (fs.existsSync(report)) {
  fs.copyFileSync(report, target);
  console.log(`prepare-assets: report copied to public/report.pdf (${fs.statSync(report).size} bytes)`);
} else if (process.env.PINRIGHT_SITE_NO_REPORT === '1') {
  fs.rmSync(target, { force: true });
  console.warn('prepare-assets: PINRIGHT_SITE_NO_REPORT=1, building without /report.pdf');
} else if (strict) {
  console.error(
    `prepare-assets: ${report} is missing. Build it first from the repository root ` +
      '(node paper/build-pdf.mjs --css paper/kit/pdf.css paper/kit/pinright-report.md) or set PINRIGHT_SITE_NO_REPORT=1 to build without it.',
  );
  process.exit(1);
} else {
  console.warn('prepare-assets: paper/kit/pinright-report.pdf is missing; /report.pdf will 404 in dev');
}
