/**
 * Cross-model summary of the agent and docs benchmarks: one row per model and arm.
 * Fills the generated part of bench/RESULTS-v6.md (between the "generated" markers;
 * the hand-written text around it is kept).
 *
 *   npx tsx bench/summary.ts --agents <stamp,stamp,...> --docs <stamp,stamp,...> [--out bench/RESULTS-v6.md]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agreement, armMetrics, LABEL, modelName } from './agents/metrics.js';
import type { RunScore } from './agents/score.js';
import { docsArmMetrics } from './docs/metrics.js';
import type { DocsRunScore } from './docs/score.js';
import { canonicalScores } from './legacy.js';
import { f0, f1, f2, f3, pct, sum, withCi } from './stats.js';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const root = resolve(import.meta.dirname, '..');
const agentStamps = (opt('agents') ?? '').split(',').filter(Boolean);
const docsStamps = (opt('docs') ?? '').split(',').filter(Boolean);
const file = resolve(root, opt('out') ?? join('bench', 'RESULTS-v6.md'));

function load<T extends { arm: string; model?: string }>(kind: 'agents' | 'docs', stamp: string) {
  const dir = join(root, 'bench', kind, 'runs', stamp);
  const scores = canonicalScores(JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8'))) as T[];
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  return { stamp, scores, reps: Number(config.reps), model: String(scores.find((s) => s.model)?.model ?? config.model) };
}
const agents = agentStamps.map((s) => load<RunScore>('agents', s));
const docs = docsStamps.map((s) => load<DocsRunScore>('docs', s));

const L: string[] = [];
const row = (cells: string[]) => L.push(`| ${cells.join(' | ')} |`);
const head = (cells: string[]) => {
  row(cells);
  L.push(`|${cells.map(() => '---').join('|')}|`);
};

L.push('### Agent security benchmark (12 tasks; whole-tree alerts from npm audit / pip-audit)', '');
head(['Model', 'Arm', 'Reps', 'Alerts, whole tree (sum)', 'Alerts per project, mean [95% CI]', 'Projects with 0 alerts', 'Direct deps with advisories', 'Critical + high (npm)', 'Builds', 'API-equivalent cost / run (USD, list price)', 'Turns', 'Duration (s)', 'MCP calls']);
for (const run of agents) {
  for (const arm of ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest']) {
    const rs = run.scores.filter((s) => s.arm === arm);
    if (!rs.length) continue;
    const m = armMetrics(rs);
    const agent = arm !== 'latest';
    row([
      modelName(run.model), LABEL[arm], agent ? String(run.reps) : '1', String(m.alertsSum), withCi(m.alertsMean, m.alertsCi), `${m.zeroAlert} / ${m.resolved}`,
      `${m.vulnDeps} / ${m.realDeps} (${pct(m.vulnDeps, m.realDeps)})`, String(m.critHigh),
      agent ? `${m.built} / ${m.conclusive}` : 'n/a', agent ? f3(m.costMean) : 'n/a', agent ? f1(m.turns) : 'n/a', agent ? f1(m.durationS) : 'n/a', agent ? f1(m.mcpCalls) : 'n/a',
    ]);
  }
}
L.push('', '"No pin" is not an agent: the no-docs agent\'s packages, installed without a version, for reference.', '');

if (docs.length) {
  L.push('### Docs benchmark (8 tasks whose library changed API in its current major)', '');
  head(['Model', 'Arm', 'Reps', 'Current API, runs [95% CI of the rate]', 'Works (install + build + smoke)', 'Deprecated API used', 'API-equivalent cost / run (USD, list price)', 'Turns', 'Duration (s)', 'MCP calls']);
  for (const run of docs) {
    for (const arm of ['no-docs', 'docs-only', 'pinright']) {
      const rs = run.scores.filter((s) => s.arm === arm);
      if (!rs.length) continue;
      const m = docsArmMetrics(rs);
      row([
        modelName(run.model), LABEL[arm], String(run.reps),
        `${m.current} / ${m.runs} (${pct(m.current, m.runs)} [${pct(m.currentCi[0], 1)}, ${pct(m.currentCi[1], 1)}])`,
        `${m.works} / ${m.runs}`, String(m.deprecated), f3(m.costMean), f1(m.turns), f1(m.durationS), f1(m.mcpCalls),
      ]);
    }
  }
  L.push('');
}

L.push('### API-equivalent cost of the runs (USD at list price, from the transcripts)', '');
head(['Model', 'Agent benchmark', 'Docs benchmark', 'Total', 'Runs']);
const models = [...new Set([...agents, ...docs].map((r) => r.model))];
for (const model of models) {
  const a = agents.filter((r) => r.model === model).flatMap((r) => r.scores);
  const d = docs.filter((r) => r.model === model).flatMap((r) => r.scores);
  const ca = sum(a.map((s) => s.costUsd ?? 0));
  const cd = sum(d.map((s) => s.costUsd ?? 0));
  row([modelName(model), f2(ca), f2(cd), f2(ca + cd), String(a.filter((s) => s.arm !== 'latest').length + d.length)]);
}
const allA = agents.flatMap((r) => r.scores);
const allD = docs.flatMap((r) => r.scores);
const ta = sum(allA.map((s) => s.costUsd ?? 0));
const td = sum(allD.map((s) => s.costUsd ?? 0));
row(['**All**', f2(ta), f2(td), `**${f2(ta + td)}**`, String(allA.filter((s) => s.arm !== 'latest').length + allD.length)]);
L.push('');

const ag = agreement(allA);
L.push('### pinright check-manifest vs npm audit / pip-audit (same lockfiles, every arm and model)', '');
head(['', 'Lockfiles', 'Alerts (audit tool)', 'Alerts (pinright)', 'Vulnerable packages, mean Jaccard', 'Identical sets']);
for (const [eco, a] of [['npm (npm audit)', ag.npm], ['PyPI (pip-audit)', ag.pypi]] as const) {
  if (a.lockfiles) row([eco, String(a.lockfiles), f0(a.auditAlerts), f0(a.oursAlerts), f2(a.jaccard), `${a.identical} / ${a.lockfiles}`]);
}
if (ag.diffs.length) L.push('', `Flagged by one side only: ${ag.diffs.slice(0, 8).map(([k, n]) => `${k.replace('only the audit tool: ', 'audit tool only: ')} (${n})`).join('; ')}.`);
L.push('');

const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';
const prev = existsSync(file) ? readFileSync(file, 'utf8') : `# Results\n\n${START}\n${END}\n`;
const i = prev.indexOf(START);
const j = prev.indexOf(END);
const out = i >= 0 && j > i ? `${prev.slice(0, i + START.length)}\n${L.join('\n')}\n${prev.slice(j)}` : `${prev}\n${START}\n${L.join('\n')}\n${END}\n`;
writeFileSync(file, out);
console.log(L.join('\n'));
