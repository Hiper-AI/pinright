/**
 * Turns one or more runs/<stamp>/scores.json (one per model) into the generated part
 * of bench/AGENTS.md (between the "generated" markers; hand-written text around it is kept).
 *
 *   npx tsx bench/agents/report.ts <stamp> [<stamp> ...]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalScores } from '../legacy.js';
import { f1, f2, f3, pct, spread, withCi } from '../stats.js';
import { agreement, armMetrics, armsOf, isAgentArm, label, modelName } from './metrics.js';
import type { RunScore } from './score.js';
import { TASKS } from './tasks.js';

const stamps = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!stamps.length) throw new Error('usage: report.ts <stamp> [<stamp> ...]');
const root = resolve(import.meta.dirname, '..', '..');

interface Run { stamp: string; scores: RunScore[]; config: { model: string; reps: number }; model: string }
const runs: Run[] = stamps.map((stamp) => {
  const runDir = join(root, 'bench', 'agents', 'runs', stamp);
  const scores: RunScore[] = canonicalScores(JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8')));
  const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));
  return { stamp, scores, config, model: scores.find((s) => s.model)?.model ?? config.model };
});

const L: string[] = [];
const row = (cells: string[]) => L.push(`| ${cells.join(' | ')} |`);
const head = (cells: string[]) => {
  row(cells);
  L.push(`|${cells.map(() => '---').join('|')}|`);
};

L.push(
  `Runs: ${runs.map((r) => `\`${r.stamp}\` (${modelName(r.model)}, ${r.config.reps} repetition(s))`).join(', ')}. ` +
    `${TASKS.length} tasks per arm (${TASKS.filter((t) => t.ecosystem === 'npm').length} npm, ${TASKS.filter((t) => t.ecosystem === 'pypi').length} PyPI). ` +
    'Intervals in brackets are 95% cluster-bootstrap intervals that resample tasks; with 12 tasks they are wide, and two arms whose intervals overlap are not shown to differ.',
  '',
);

for (const run of runs) {
  const { scores } = run;
  const name = modelName(run.model);
  const arms = armsOf(scores.map((s) => s.arm));
  const M = Object.fromEntries(arms.map((a) => [a, armMetrics(scores.filter((s) => s.arm === a))]));
  type Mx = (typeof M)[string];
  L.push(`## ${name} (\`${run.model}\`, run \`${run.stamp}\`, ${run.config.reps} repetition(s))`, '');
  head(['Metric', ...arms.map((a) => label(a))]);
  const metric = (label: string, f: (m: Mx, arm: string) => string) => row([label, ...arms.map((a) => f(M[a], a))]);
  const agentOnly = (f: (m: Mx) => string) => (m: Mx, a: string) => (isAgentArm(a) ? f(m) : 'n/a');
  metric('Runs with a manifest', (m) => `${m.withManifest} / ${m.runs}`);
  metric('Direct dependencies pinned', (m) => String(m.deps));
  metric('Direct deps with >= 1 advisory', (m) => `${m.vulnDeps} (${pct(m.vulnDeps, m.realDeps)})`);
  metric('Direct deps with CVSS >= 7', (m) => `${m.highDeps} (${pct(m.highDeps, m.realDeps)})`);
  metric('Pinned version or package does not exist', (m) => String(m.missingDeps));
  metric('Manifests that fail to resolve', (m) => String(m.withManifest - m.resolved));
  metric('Dependabot-style alerts, whole tree (sum)', (m) => String(m.alertsSum));
  metric('Alerts per project (mean [95% CI])', (m) => withCi(m.alertsMean, m.alertsCi));
  metric('Projects with 0 alerts', (m) => `${m.zeroAlert} / ${m.resolved}`);
  metric('Critical + high alerts (npm trees)', (m) => String(m.critHigh));
  metric('Projects that install', agentOnly((m) => `${m.installed} / ${m.builds}`));
  metric('Projects that build / import cleanly', agentOnly((m) => `${m.built} / ${m.conclusive}`));
  metric('Median age of pinned version (days)', (m) => String(m.medianAge));
  metric('Direct deps on the registry default', (m) => (Number.isFinite(m.onDefault) ? `${Math.round(100 * m.onDefault)}%` : 'n/a'));
  metric('API-equivalent cost per run (USD, list price, mean)', agentOnly((m) => f3(m.costMean)));
  metric('API-equivalent cost, all runs of the arm (USD, list price)', agentOnly((m) => f2(m.costSum)));
  metric('Turns per run (mean)', agentOnly((m) => f1(m.turns)));
  metric('Duration per run (s, mean)', agentOnly((m) => f1(m.durationS)));
  metric('MCP calls per run (mean)', agentOnly((m) => f1(m.mcpCalls)));
  metric('Hook blocks per run (mean)', agentOnly((m) => f1(m.hookBlocks)));
  L.push('');

  L.push(`### Whole-tree alerts per task, ${name}`, '', 'Mean over repetitions, (min-max) when they differ; x = did not build.', '');
  head(['Task', 'Ecosystem', ...arms.map((a) => label(a))]);
  for (const t of TASKS) {
    const cells = arms.map((a) => {
      const rs = scores.filter((s) => s.arm === a && s.task === t.id);
      if (!rs.length) return '';
      const ok = rs.filter((r) => r.tree?.resolved);
      const missing = rs.filter((r) => !r.deps.length).length;
      const unresolved = rs.length - ok.length - missing;
      const broken = rs.filter((r) => r.build && r.build.step !== 'none' && !r.build.inconclusive && !r.build.built).length;
      const notes = [unresolved ? `${unresolved} unresolved` : '', missing ? `${missing} no manifest` : ''].filter(Boolean).join(', ');
      return `${spread(ok.map((r) => r.tree?.alerts ?? 0))}${notes ? ` (${notes})` : ''}${broken ? ` ${'x'.repeat(broken)}` : ''}`;
    });
    row([t.id, t.ecosystem, ...cells]);
  }
  L.push('');

  L.push(`### Runs without a manifest or that do not build, ${name}`, '');
  for (const a of arms.filter(isAgentArm)) {
    const noManifest = scores.filter((s) => s.arm === a && !s.deps.length);
    const bad = scores.filter((s) => s.arm === a && s.build && s.build.step !== 'none' && (!s.build.installed || !s.build.built));
    L.push(`**${label(a)}**: ${bad.length || noManifest.length ? '' : 'none'}`, '');
    for (const s of noManifest) L.push(`- ${s.task} r${s.rep}: no manifest written (agent ${s.ok ? 'finished' : 'did not finish'}, ${s.turns ?? '?'} turns)`);
    for (const s of bad) {
      const b = s.build!;
      L.push(`- ${s.task} r${s.rep}: ${b.installed ? b.step : 'install'} failed${b.inconclusive ? ' (native binary, inconclusive)' : ''}: \`${(b.error ?? '').replace(/\s*\(?[A-Z]:\\[^\s)]*\)?/g, '').replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 180)}\``);
    }
    L.push('');
  }

  L.push(`### Vulnerable or non-existent direct pins, ${name}`, '');
  for (const a of arms.filter(isAgentArm)) {
    const bad = new Map<string, number>();
    for (const r of scores.filter((s) => s.arm === a)) {
      for (const d of r.deps) {
        let key: string | undefined;
        if (d.exists !== 'yes') key = `${d.name}@${d.version} (does not exist)`;
        else if (d.advisories.length) key = `${d.name}@${d.version} (${d.advisories.length} advisories${d.maxCvss ? `, CVSS ${d.maxCvss}` : ''}; default ${d.latest})`;
        if (key) bad.set(key, (bad.get(key) ?? 0) + 1);
      }
    }
    L.push(`**${label(a)}**: ${bad.size ? '' : 'none'}`, '');
    const list = [...bad.entries()].sort((x, y) => y[1] - x[1]);
    for (const [k, n] of list.slice(0, 15)) L.push(`- ${k}${n > 1 ? ` x${n}` : ''}`);
    if (list.length > 15) L.push(`- ... ${list.length - 15} more`);
    L.push('');
  }
}

const ag = agreement(runs.flatMap((r) => r.scores));
L.push('## pinright check-manifest vs npm audit / pip-audit (same lockfiles, all models)', '');
head(['', 'Lockfiles', 'Alerts (audit tool)', 'Alerts (pinright)', 'Vulnerable packages, mean Jaccard', 'Identical sets']);
for (const [eco, a] of [['npm (npm audit)', ag.npm], ['PyPI (pip-audit)', ag.pypi]] as const) {
  if (a.lockfiles) row([eco, String(a.lockfiles), String(a.auditAlerts), String(a.oursAlerts), f2(a.jaccard), String(a.identical)]);
}
if (ag.diffs.length) {
  L.push('', 'Packages flagged by one side only (times seen):', '');
  for (const [k, n] of ag.diffs.slice(0, 15)) L.push(`- ${k} x${n}`);
}
L.push('');

L.push('## Reproduce', '', '```bash', 'npm ci && npm run build');
for (const r of runs) {
  L.push(`GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model ${r.config.model} --reps ${r.config.reps} --concurrency 3 --stamp ${r.stamp}`);
  if (r.scores.some((s) => s.arm === 'docs-only')) {
    L.push(`GITHUB_TOKEN=... npx tsx bench/agents/run.ts --model ${r.config.model} --reps ${r.config.reps} --concurrency 3 --stamp ${r.stamp} --arms docs-only --resume`);
  }
  L.push(`npx tsx bench/agents/make-latest.ts ${r.stamp} && npx tsx bench/agents/score.ts ${r.stamp} --concurrency 3`);
}
L.push(`npx tsx bench/agents/report.ts ${stamps.join(' ')}`, '```', '');

const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';
const file = join(root, 'bench', 'AGENTS.md');
const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
const i = prev.indexOf(START);
const j = prev.indexOf(END);
const out = i >= 0 && j > i ? `${prev.slice(0, i + START.length)}\n${L.join('\n')}\n${prev.slice(j)}` : `# Agent benchmark\n\n${START}\n${L.join('\n')}\n${END}\n`;
writeFileSync(file, out);
console.log(`wrote ${file}`);
