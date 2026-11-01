/* eslint-disable @typescript-eslint/no-explicit-any -- the SARIF file is read untyped */
/**
 * Captures pinright's own CLI output and renders it as terminal panels (SVG, and PNG at 2x when
 * a local Chrome or Edge exists) for paper/kit/visuals/cli.
 *
 *   npm run build
 *   npx tsx paper/kit/render-cli.ts --project <dir with a package.json to audit> [--no-png]
 *
 * Runs `pinright doctor`, `pinright check npm lodash@4.17.20` and
 * `pinright audit package.json --fail-on high --sarif ...` from dist/cli.js with a throwaway HOME
 * and cache, no GitHub token, and FORCE_COLOR=1. Every absolute path in the output is rewritten
 * (the temp HOME becomes ~, the project becomes ~/demo-app), so no personal path ends up in a
 * picture. The kit used the no-docs Sonnet project of the axios task from run v6
 * (bench/agents/runs/v6-sonnet-2026-11-01/no-docs/axios-client-r1/work), a manifest a coding
 * agent wrote from memory.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Mode, pngFromSvg, terminal } from './svg.js';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const project = opt('project');
if (!project) {
  console.error('usage: npx tsx paper/kit/render-cli.ts --project <dir with a package.json> [--no-png]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'cli.js');
const outDir = join(import.meta.dirname, 'visuals', 'cli');
mkdirSync(outDir, { recursive: true });
const wantPng = !args.includes('--no-png');

const tmp = mkdtempSync(join(tmpdir(), 'pinright-cli-'));
const home = join(tmp, 'home');
const demo = join(tmp, 'demo-app');
mkdirSync(home, { recursive: true });
mkdirSync(demo, { recursive: true });
const proj = resolve(project);
const sarifPath = join(tmp, 'pinright.sarif');

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'), XDG_CACHE_HOME: join(home, '.cache'), PINRIGHT_CACHE_DIR: join(home, '.cache', 'pinright'), FORCE_COLOR: '1', COLUMNS: '100' };
for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'PINRIGHT_GH_CLI']) delete env[k];

/** Every spelling of a path the CLI may print: backslashes, forward slashes, and the long form of a short (8.3) temp dir. */
function variants(p: string): string[] {
  const out = new Set([p, p.replace(/\\/g, '/')]);
  for (const v of [...out]) out.add(v.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`));
  return [...out].sort((a, b) => b.length - a.length);
}
function sanitize(s: string): string {
  let out = s;
  for (const [from, to] of [[proj, '~/demo-app'], [demo, '~/demo-app'], [home, '~'], [tmp, '/tmp']] as const) {
    for (const v of variants(from)) out = out.split(v).join(to);
  }
  // Long and short forms of the user's temp folder, should the CLI print either.
  out = out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+[\\/]AppData[\\/]Local[\\/]Temp[\\/]pinright-cli-[A-Za-z0-9]+/g, '/tmp');
  // What follows a rewritten path keeps the OS separator; use / after ~ for one style.
  return out.replace(/(~(?:\/demo-app)?|\/tmp)((?:\\[^\\\s]+)+)/g, (_, head: string, tail: string) => head + tail.replace(/\\/g, '/'));
}

function run(cwd: string, cliArgs: string[]) {
  const r = spawnSync(process.execPath, [cli, ...cliArgs], { cwd, env, encoding: 'utf8', timeout: 180_000 });
  return { code: r.status ?? 1, text: sanitize(`${r.stdout ?? ''}${r.stderr ?? ''}`).trimEnd() };
}

const shots: { id: string; title: string; command: string; text: string; desc: string }[] = [];
const doctor = run(demo, ['doctor']);
shots.push({ id: 'pinright-doctor', title: 'pinright doctor', command: 'npx pinright doctor', text: doctor.text, desc: 'pinright doctor output: Node version, each upstream (deps.dev, OSV, npm, PyPI, Packagist, jsDelivr, GitHub) with its response time, the cache, the policy file, hook startup time, and the agents found.' });
const check = run(demo, ['check', 'npm', 'lodash@4.17.20']);
shots.push({ id: 'pinright-check-lodash', title: 'pinright check', command: 'npx pinright check npm lodash@4.17.20', text: check.text, desc: 'pinright check for lodash 4.17.20: a security notice with 5 advisories (2 high, 3 moderate) and the recommendation to move to 4.18.1 on the same 4.x line.' });
const audit = run(proj, ['audit', 'package.json', '--fail-on', 'high', '--sarif', sarifPath, '--sarif-root', proj]);
shots.push({ id: 'pinright-audit-sarif', title: 'pinright audit --sarif', command: 'npx pinright audit package.json --fail-on high --sarif /tmp/pinright.sarif', text: audit.text, desc: 'pinright audit of an agent-written package.json (axios 1.7.9, form-data 4.0.1): 35 alerts in 29 packages, the fix for each direct dependency, and the SARIF file written.' });

// A short summary of the SARIF file, computed from it (not CLI output: the panel title says so).
const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
const runSarif = sarif.runs[0];
const levels: Record<string, number> = {};
for (const x of runSarif.results) levels[x.level] = (levels[x.level] ?? 0) + 1;
const sev = (r: { ruleIndex: number }) => runSarif.tool.driver.rules[r.ruleIndex]?.properties?.['security-severity'];
const summary = [
  `tool        ${runSarif.tool.driver.name} ${runSarif.tool.driver.version}, SARIF ${sarif.version}`,
  `rules       ${runSarif.tool.driver.rules.length}`,
  `results     ${runSarif.results.length}: ${Object.entries(levels).map(([k, v]) => `${v} ${k}`).join(', ')}`,
  `locations   ${[...new Set(runSarif.results.map((r: any) => `${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri}:${r.locations?.[0]?.physicalLocation?.region?.startLine}`))].join(', ')}`,
  `fingerprint partialFingerprints.primaryLocationLineHash on every result`,
  '',
  ...runSarif.results.slice(0, 3).map((r: any) => `${r.level.padEnd(8)} ${r.ruleId} (security-severity ${sev(r) ?? 'n/a'}): ${r.message.text.split('. Severity')[0]}`),
  `... ${runSarif.results.length - 3} more`,
];
shots.push({ id: 'pinright-sarif-summary', title: 'pinright.sarif, summarized (fields read from the file)', command: '', text: sanitize(summary.join('\n')), desc: `Summary of the SARIF 2.1.0 file pinright audit wrote: ${runSarif.results.length} results with rule ids, levels, security-severity and stable fingerprints, located at the package.json lines that bring each package in.` });

for (const s of shots) {
  writeFileSync(join(outDir, `${s.id}.txt`), `${s.text}\n`);
  for (const mode of ['light', 'dark'] as Mode[]) {
    const { svg, w, h } = terminal({ mode, title: s.title, command: s.command || undefined, prompt: '~/demo-app $', lines: s.text.split('\n'), cols: 110, desc: s.desc });
    const base = join(outDir, mode === 'light' ? s.id : `${s.id}-dark`);
    writeFileSync(`${base}.svg`, svg);
    if (wantPng && !pngFromSvg(`${base}.svg`, `${base}.png`, w, h)) console.warn(`no PNG for ${s.id}: no local Chrome or Edge`);
  }
  console.log(`visuals/cli/${s.id} (${s.text.split('\n').length} lines)`);
}
console.log(`exit codes: doctor ${doctor.code}, check ${check.code}, audit ${audit.code}`);
rmSync(tmp, { recursive: true, force: true });
