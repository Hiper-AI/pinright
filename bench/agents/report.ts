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

const ARMS = ['no-docs', 'context7', 'safectx', 'latest'];
const LABEL: Record<string, string> = {
  'no-docs': 'Agent, no docs',
  context7: 'Agent + Context7',
  safectx: 'Agent + safectx',
  latest: 'No pin (`npm install x`)',
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

interface ArmStats { [k: string]: string }
const stats: Record<string, ArmStats> = {};
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
  stats[arm] = {
    'Runs with a manifest': `${withManifest.length} / ${runs.length}`,
    'Direct dependencies pinned': String(deps.length),
    'Direct deps with >= 1 advisory': `${vuln.length} (${pct(vuln.length, real.length)})`,
    'Direct deps with CVSS >= 7': `${high.length} (${pct(high.length, real.length)})`,
    'Pinned version or package does not exist': String(missing.length),
    'Deprecated direct deps': String(real.filter((d) => d.deprecated).length),
    'Manifests that fail to resolve': String(withManifest.length - resolved.length),
    'Dependabot-style alerts, whole tree (sum)': String(alerts.reduce((a, b) => a + b, 0)),
    'Alerts per project (mean)': f1(mean(alerts)),
    'Projects with 0 alerts': `${alerts.filter((a) => a === 0).length} / ${resolved.length}`,
    'Critical + high alerts (npm trees)': String(npmResolved.reduce((a, r) => a + (r.tree?.critical ?? 0) + (r.tree?.high ?? 0), 0)),
    'Median age of pinned version (days)': String(median(real.map((d) => d.ageDays ?? NaN).filter(Number.isFinite))),
    'Direct deps on the registry default': pct(real.filter((d) => d.isLatest).length, real.length),
    'Cost per run (USD, mean)': agent ? f2(mean(runs.map((r) => r.costUsd ?? NaN).filter(Number.isFinite))) : 'n/a',
    'Turns per run (mean)': agent ? f1(mean(runs.map((r) => r.turns ?? NaN).filter(Number.isFinite))) : 'n/a',
    'Duration per run (s, mean)': agent ? f1(mean(runs.map((r) => (r.durationMs ?? NaN) / 1000).filter(Number.isFinite))) : 'n/a',
    'MCP calls per run (mean)': agent ? f1(mean(runs.map((r) => Object.values(r.mcpCalls).reduce((a, b) => a + b, 0)))) : 'n/a',
  };
}

const arms = ARMS.filter((a) => stats[a]);
const rows = Object.keys(stats[arms[0]]);
const lines: string[] = [];
lines.push('# Agent benchmark: no docs vs Context7 vs safectx', '');
lines.push(
  `Run \`${stamp}\`, model \`${scores.find((s) => s.model)?.model ?? config.model}\`, ${config.reps} repetition(s) of ${TASKS.length} tasks per arm. ` +
    'Each run is Claude Code in headless mode with only Write and Read as built-in tools (no shell, no web); the arms differ only in the MCP server. ' +
    'The prompt is identical in every arm and asks for exact pinned versions.',
  '',
);
lines.push(
  'The "No pin" column has no agent: it takes the packages the no-docs agent chose and installs them without a version. ' +
    'Whole-tree alerts come from `npm audit` (over a lockfile resolved with `--package-lock-only`) and from `pip-audit` (over `uv pip compile` output). ' +
    'Neither tool shares code or a data path with safectx, and both read the GitHub Advisory Database / PyPI advisories that Dependabot alerts on. ' +
    'Direct-dependency advisories and CVSS come from deps.dev.',
  '',
);
lines.push(`| Metric | ${arms.map((a) => LABEL[a]).join(' | ')} |`);
lines.push(`|---|${arms.map(() => '---').join('|')}|`);
for (const r of rows) lines.push(`| ${r} | ${arms.map((a) => stats[a][r]).join(' | ')} |`);
lines.push('');

lines.push('## Whole-tree alerts per task (mean over repetitions)', '');
lines.push(`| Task | Ecosystem | ${arms.map((a) => LABEL[a]).join(' | ')} |`);
lines.push(`|---|---|${arms.map(() => '---').join('|')}|`);
for (const t of TASKS) {
  const cells = arms.map((a) => {
    const rs = scores.filter((s) => s.arm === a && s.task === t.id);
    if (!rs.length) return '';
    const ok = rs.filter((r) => r.tree?.resolved);
    const failed = rs.length - ok.length;
    const m = mean(ok.map((r) => r.tree?.alerts ?? 0));
    return `${Number.isFinite(m) ? f1(m) : '-'}${failed ? ` (${failed} unresolved)` : ''}`;
  });
  lines.push(`| ${t.id} | ${t.ecosystem} | ${cells.join(' | ')} |`);
}
lines.push('');

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
  for (const [k, n] of [...bad.entries()].sort((x, y) => y[1] - x[1])) lines.push(`- ${k}${n > 1 ? ` x${n}` : ''}`);
  lines.push('');
}

lines.push('## Reproduce', '', '```bash', 'npm run build',
  `npx tsx bench/agents/run.ts --model ${config.model} --reps ${config.reps} --stamp <stamp>`,
  'npx tsx bench/agents/make-latest.ts <stamp>', 'npx tsx bench/agents/score.ts <stamp>', 'npx tsx bench/agents/report.ts <stamp>', '```', '');

writeFileSync(join(root, 'bench', 'AGENTS.md'), lines.join('\n'));
console.log(lines.slice(0, rows.length + 8).join('\n'));
