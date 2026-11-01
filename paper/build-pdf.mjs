#!/usr/bin/env node
// Renders paper/pinright-report.md to paper/pinright-report.pdf without installing anything global.
//
//   node paper/build-pdf.mjs [--css extra.css] [file.md ...]
//
//   node paper/build-pdf.mjs --css paper/kit/pdf.css paper/kit/pinright-report.md   # the paper kit
//
// Images are resolved relative to the Markdown file. `--css` adds a stylesheet after paper/pdf.css.
//
// Order: pandoc, when it is on PATH and has a PDF engine; otherwise md-to-pdf through npx (pinned
// version), driving a Chrome or Edge already installed on the machine when one is found. If neither
// works, the Markdown stays the deliverable and the script says so (exit 0).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const extraCss = [];
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--css') extraCss.push(resolve(argv[++i]));
  else files.push(resolve(argv[i]));
}
const inputs = files.length ? files : [join(here, 'pinright-report.md')];
// 5.2.4 carries CVE-2025-65108 (critical); pinright's hook flagged it on 2026-11-01.
const MD_TO_PDF = 'md-to-pdf@5.2.5';
const isWin = process.platform === 'win32';

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } });
  return r.status === 0;
}

function has(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: isWin }).status === 0;
}

function localBrowser() {
  const candidates = isWin
    ? [
        join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => p && existsSync(p));
}

function withPandoc(md, pdf) {
  if (!has('pandoc')) return false;
  for (const engine of ['xelatex', 'lualatex', 'pdflatex', 'wkhtmltopdf', 'weasyprint']) {
    if (!has(engine)) continue;
    console.log(`pandoc (${engine}): ${md}`);
    if (run('pandoc', [md, '-o', pdf, `--pdf-engine=${engine}`, '--resource-path', dirname(md), '-V', 'geometry:margin=2cm', '-V', 'colorlinks=true'])) return true;
  }
  return false;
}

function withMdToPdf(md) {
  const browser = localBrowser();
  // A config file instead of JSON on the command line: npx needs a shell on Windows, and the
  // shell would mangle the quotes.
  const config = {
    stylesheet: [join(here, 'pdf.css'), ...extraCss],
    basedir: dirname(md),
    pdf_options: {
      format: 'A4',
      margin: { top: '18mm', bottom: '20mm', left: '18mm', right: '18mm' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    },
    launch_options: browser ? { executablePath: browser, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] },
  };
  const configFile = join(mkdtempSync(join(tmpdir(), 'pinright-pdf-')), 'md-to-pdf.json');
  writeFileSync(configFile, JSON.stringify(config));
  console.log(`${MD_TO_PDF}${browser ? ` with ${browser}` : ' (puppeteer downloads its own Chrome)'}: ${md}`);
  const quote = (s) => (isWin ? `"${s}"` : s);
  return run('npx', ['-y', MD_TO_PDF, quote(md), '--config-file', quote(configFile)], browser ? { PUPPETEER_SKIP_DOWNLOAD: '1', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1' } : {});
}

let failed = 0;
for (const md of inputs) {
  const pdf = md.replace(/\.md$/i, '.pdf');
  if (withPandoc(md, pdf) || withMdToPdf(md)) {
    console.log(`wrote ${pdf}`);
  } else {
    failed++;
    console.log(`no PDF renderer worked for ${md}; the Markdown file is the deliverable.`);
  }
}
// Exit 0 either way: a missing renderer leaves the Markdown as the deliverable, not an error.
process.exit(0);
