/**
 * Turns runs/<stamp>/scores.json into bench/AGENTS.md.
 *
 *   npx tsx bench/agents/report.ts <stamp>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunScore } from './score.js';
import { TASKS } from './tasks.js';

const stamp = process.argv[2];
if (!stamp) throw new Error('usage: report.ts <stamp>');
const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'agents', 'runs', stamp);
const scores: RunScore[] = JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));

const ARMS = ['no-docs', 'safectx', 'hook-only', 'safectx+hook', 'latest'];
const LABEL: Record<string, string> = {
  'no-docs': 'No docs',
  safectx: 'safectx MCP',
  'hook-only': 'safectx hook only',
  'safectx+hook': 'safectx MCP + hook',
  latest: 'No pin (reference)',
};

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

const stats: Record<string, Record<string, string>> = {};
for (const arm of ARMS) {
  const runs = scores.filter((s) => s.arm === arm);
  if (!runs.length) continue;
  const withManifest = runs.filter((r) => r.deps.length);
  const deps = withManifest.flatMap((r) => r.deps);
  const real = deps.filter((d) => d.exists === 'yes');
  const vuln = real.filter((d) => d.advisories.length);
  const high = real.filter((d) => (d.maxCvss ?? 0) >= 7);
  const missing = deps.filter((d) => d.exists !== 'yes');
  const resolved = withManifest.filter((r) => r.tree?.resolved);
  const alerts = resolved.map((r) => r.tree?.alerts ?? 0);
  const npmResolved = resolved.filter((r) => r.ecosystem === 'npm');
  const agent = arm !== 'latest';
  const builds = runs.filter((r) => r.build);
  const withCode = builds.filter((r) => r.build?.step !== 'none');
  const conclusive = withCode.filter((r) => !r.build?.inconclusive);
  stats[arm] = {
    'Runs with a manifest': `${withManifest.length} / ${runs.length}`,
    'Direct dependencies pinned': String(deps.length),
    'Direct deps with >= 1 advisory': `${vuln.length} (${pct(vuln.length, real.length)})`,
    'Direct deps with CVSS >= 7': `${high.length} (${pct(high.length, real.length)})`,
    'Pinned version or package does not exist': String(missing.length),
    'Manifests that fail to resolve': String(withManifest.length - resolved.length),
    'Dependabot-style alerts, whole tree (sum)': String(alerts.reduce((a, b) => a + b, 0)),
    'Alerts per project (mean)': f1(mean(alerts)),
    'Projects with 0 alerts': `${alerts.filter((a) => a === 0).length} / ${resolved.length}`,
    'Critical + high alerts (npm trees)': String(npmResolved.reduce((a, r) => a + (r.tree?.critical ?? 0) + (r.tree?.high ?? 0), 0)),
    'Projects that install': agent ? `${builds.filter((r) => r.build?.installed).length} / ${builds.length}` : 'n/a',
    'Projects that build / import cleanly': agent ? `${conclusive.filter((r) => r.build?.built).length} / ${conclusive.length}` : 'n/a',
    'Median age of pinned version (days)': String(median(real.map((d) => d.ageDays ?? NaN).filter(Number.isFinite))),
    'Direct deps on the registry default': pct(real.filter((d) => d.isLatest).length, real.length),
    'Cost per run (USD, mean)': agent ? f2(mean(runs.map((r) => r.costUsd ?? NaN).filter(Number.isFinite))) : 'n/a',
    'Turns per run (mean)': agent ? f1(mean(runs.map((r) => r.turns ?? NaN).filter(Number.isFinite))) : 'n/a',
    'Duration per run (s, mean)': agent ? f1(mean(runs.map((r) => (r.durationMs ?? NaN) / 1000).filter(Number.isFinite))) : 'n/a',
    'MCP calls per run (mean)': agent ? f1(mean(runs.map((r) => Object.values(r.mcpCalls).reduce((a, b) => a + b, 0)))) : 'n/a',
    'Hook blocks per run (mean)': agent ? f1(mean(runs.map((r) => r.hookBlocks ?? 0))) : 'n/a',
  };
}

const arms = ARMS.filter((a) => stats[a]);
const rows = Object.keys(stats[arms[0]]);
const lines: string[] = [];
lines.push('# Agent benchmark: no docs vs safectx', '');
lines.push(
  `Run \`${stamp}\`, model \`${scores.find((s) => s.model)?.model ?? config.model}\`, ${config.reps} repetition(s) of ${TASKS.length} tasks per arm ` +
    `(${TASKS.filter((t) => t.ecosystem === 'npm').length} npm, ${TASKS.filter((t) => t.ecosystem === 'pypi').length} PyPI). ` +
    'Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web). The prompt is identical in every arm and asks for exact pinned versions. ' +
    'Arms differ only in what is attached: nothing, the safectx MCP server (its docs come from the packages themselves), the safectx pre-install hook alone, or both.',
  '',
);
lines.push(
  '"No pin" has no agent: the packages the no-docs agent chose, installed without a version. ' +
    'Whole-tree alerts come from `npm audit` (lockfile resolved with `--package-lock-only`) and `pip-audit` (over `uv pip compile` output); neither shares code or data path with safectx, and both read the advisory data Dependabot alerts on. ' +
    '"Build" means a real `npm install` plus `npm run build`, `tsc --noEmit` or an import check for JavaScript, and for Python `uv pip install` plus executing every top-level import of the generated files. ' +
    'Builds that fail only because a native binary needs an install script (never run here) are left out as inconclusive.',
  '',
);
lines.push(`| Metric | ${arms.map((a) => LABEL[a]).join(' | ')} |`);
lines.push(`|---|${arms.map(() => '---').join('|')}|`);
for (const r of rows) lines.push(`| ${r} | ${arms.map((a) => stats[a][r]).join(' | ')} |`);
lines.push('');

lines.push('## Whole-tree alerts per task (mean over repetitions; x = did not build)', '');
lines.push(`| Task | Ecosystem | ${arms.map((a) => LABEL[a]).join(' | ')} |`);
lines.push(`|---|---|${arms.map(() => '---').join('|')}|`);
for (const t of TASKS) {
  const cells = arms.map((a) => {
    const rs = scores.filter((s) => s.arm === a && s.task === t.id);
    if (!rs.length) return '';
    const ok = rs.filter((r) => r.tree?.resolved);
    const unresolved = rs.length - ok.length;
    const broken = rs.filter((r) => r.build && r.build.step !== 'none' && !r.build.inconclusive && !r.build.built).length;
    const m = mean(ok.map((r) => r.tree?.alerts ?? 0));
    return `${Number.isFinite(m) ? f1(m) : '-'}${unresolved ? ` (${unresolved} unresolved)` : ''}${broken ? ` ${'x'.repeat(broken)}` : ''}`;
  });
  lines.push(`| ${t.id} | ${t.ecosystem} | ${cells.join(' | ')} |`);
}
lines.push('');

lines.push('## Build failures', '');
for (const a of arms.filter((x) => x !== 'latest')) {
  const bad = scores.filter((s) => s.arm === a && s.build && s.build.step !== 'none' && (!s.build.installed || !s.build.built));
  lines.push(`**${LABEL[a]}**: ${bad.length ? '' : 'none'}`, '');
  for (const s of bad) {
    const b = s.build!;
    lines.push(`- ${s.task} r${s.rep}: ${b.installed ? b.step : 'install'} failed${b.inconclusive ? ' (native binary, inconclusive)' : ''}: \`${(b.error ?? '').replace(/`/g, "'").slice(0, 180)}\``);
  }
  lines.push('');
}

// safectx check-manifest against npm audit / pip-audit on the very same files.
const pairs = scores.filter((s) => ARMS.includes(s.arm) && s.tree?.resolved && s.tree.safectx && s.tree.auditNames);
if (pairs.length) {
  const agree = pairs.map((s) => {
    const A = new Set(s.tree!.auditNames);
    const B = new Set(s.tree!.safectx!.vulnerableNames);
    const union = new Set([...A, ...B]);
    const inter = [...A].filter((x) => B.has(x)).length;
    return { s, jaccard: union.size ? inter / union.size : 1, onlyAudit: [...A].filter((x) => !B.has(x)), onlyOurs: [...B].filter((x) => !A.has(x)) };
  });
  const byEco = (eco: string) => agree.filter((x) => x.s.ecosystem === eco);
  lines.push('## safectx check-manifest vs npm audit / pip-audit (same lockfiles)', '');
  lines.push('| | Lockfiles | Alerts (audit tool) | Alerts (safectx) | Vulnerable packages, mean Jaccard | Identical sets |');
  lines.push('|---|---|---|---|---|---|');
  for (const eco of ['npm', 'pypi']) {
    const xs = byEco(eco);
    if (!xs.length) continue;
    lines.push(
      `| ${eco === 'npm' ? 'npm (npm audit)' : 'PyPI (pip-audit)'} | ${xs.length} | ${xs.reduce((a, x) => a + (x.s.tree!.alerts ?? 0), 0)} | ${xs.reduce((a, x) => a + x.s.tree!.safectx!.alerts, 0)} | ${f2(mean(xs.map((x) => x.jaccard)))} | ${xs.filter((x) => x.jaccard === 1).length} |`,
    );
  }
  const diffs = new Map<string, number>();
  for (const x of agree) {
    for (const n of x.onlyAudit) diffs.set(`only the audit tool: ${n}`, (diffs.get(`only the audit tool: ${n}`) ?? 0) + 1);
    for (const n of x.onlyOurs) diffs.set(`only safectx: ${n}`, (diffs.get(`only safectx: ${n}`) ?? 0) + 1);
  }
  if (diffs.size) {
    lines.push('', 'Packages flagged by one side only (times seen):', '');
    for (const [k, n] of [...diffs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`- ${k} x${n}`);
  }
  lines.push('');
}

lines.push('## Vulnerable or non-existent direct pins, by arm', '');
for (const a of arms.filter((x) => x !== 'latest')) {
  const bad = new Map<string, number>();
  for (const r of scores.filter((s) => s.arm === a)) {
    for (const d of r.deps) {
      let key: string | undefined;
      if (d.exists !== 'yes') key = `${d.name}@${d.version} (does not exist)`;
      else if (d.advisories.length) key = `${d.name}@${d.version} (${d.advisories.length} advisories${d.maxCvss ? `, CVSS ${d.maxCvss}` : ''}; default ${d.latest})`;
      if (key) bad.set(key, (bad.get(key) ?? 0) + 1);
    }
  }
  lines.push(`**${LABEL[a]}**: ${bad.size ? '' : 'none'}`, '');
  for (const [k, n] of [...bad.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20)) lines.push(`- ${k}${n > 1 ? ` x${n}` : ''}`);
  lines.push('');
}

lines.push('## Reproduce', '', '```bash', 'npm run build',
  `GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model ${config.model} --reps ${config.reps} --stamp <stamp>`,
  'npx tsx bench/agents/make-latest.ts <stamp>', 'npx tsx bench/agents/score.ts <stamp>', 'npx tsx bench/agents/report.ts <stamp>', '```', '');

writeFileSync(join(root, 'bench', 'AGENTS.md'), lines.join('\n'));
console.log(lines.slice(0, rows.length + 10).join('\n'));
