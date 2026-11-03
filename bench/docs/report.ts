/**
 * Turns one or more runs/<stamp>/scores.json (one per model) into the generated part
 * of bench/DOCS.md (between the "generated" markers; the hand-written diagnosis around it is kept).
 *
 *   npx tsx bench/docs/report.ts <stamp> [<stamp> ...] [--set v6|post-cutoff] [--file path.md]
 *
 * The task set comes from --set or from the first run's config.json (default v6). The
 * v6 set writes into bench/DOCS.md; any other set into bench/RESULTS-<set>.md, unless
 * --file says otherwise. Sets other than v6 also get a cross-model table with Wilson
 * intervals at the top.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { modelName } from '../agents/metrics.js';
import { canonicalScores } from '../legacy.js';
import { f1, f2, f3, pct, wilson } from '../stats.js';
import { docsArmMetrics } from './metrics.js';
import { ARMS, type DocsRunScore } from './score.js';
import { DEFAULT_SET, setFromArgs, taskSet } from './sets.js';

const argv = process.argv.slice(2);
const VALUED = new Set(['--set', '--file']);
const stamps = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!stamps.length) throw new Error('usage: report.ts <stamp> [<stamp> ...] [--set name] [--file path]');
const root = resolve(import.meta.dirname, '..', '..');

const LABEL: Record<string, string> = { 'no-docs': 'No docs', 'docs-only': 'docs-only (pinright with the security layer off)', pinright: 'pinright' };
const label = (a: string) => LABEL[a] ?? a;

const L: string[] = [];
const row = (cells: string[]) => L.push(`| ${cells.join(' | ')} |`);
const head = (cells: string[]) => {
  row(cells);
  L.push(`|${cells.map(() => '---').join('|')}|`);
};

const runs = stamps.map((stamp) => {
  const runDir = join(root, 'bench', 'docs', 'runs', stamp);
  const scores: DocsRunScore[] = canonicalScores(JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8')));
  const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));
  return { stamp, scores, config, model: scores.find((s) => s.model)?.model ?? config.model };
});

const set = setFromArgs(argv, runs[0].config.set ?? DEFAULT_SET);
for (const r of runs) if ((r.config.set ?? DEFAULT_SET) !== set) throw new Error(`${r.stamp} ran the ${r.config.set ?? DEFAULT_SET} set, not ${set}`);
const TASKS = taskSet(set);
const smokeTasks = TASKS.filter((t) => t.smoke).length;
const wilsonTxt = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${pct(k, n)} [${pct(lo, 1)}, ${pct(hi, 1)}]`;
};
const armsOf = (scores: DocsRunScore[]) => [...ARMS.filter((a) => scores.some((s) => s.arm === a)), ...[...new Set(scores.map((s) => s.arm))].filter((a) => !ARMS.includes(a)).sort()];

L.push(
  `Runs: ${runs.map((r) => `\`${r.stamp}\` (${modelName(r.model)}, ${r.config.reps} repetition(s), ${r.scores.length} runs scored)`).join(', ')}. ` +
    `${TASKS.length} tasks per arm (set \`${set}\`). Brackets: 95% cluster-bootstrap interval of the rate, resampling tasks; with ${TASKS.length} tasks it is wide.` +
    (set === DEFAULT_SET ? '' : ' The Wilson column treats every run as independent, which repetitions of one task are not, so it is narrower than it should be.'),
  '',
);

if (set !== DEFAULT_SET) {
  head(['Model', 'Arm', 'Current API, runs', '95% Wilson', '95% task bootstrap', 'Works (install + build)', 'Pinned a version with the API', 'Required checks all present', 'Runs using a removed API', 'Runs using a deprecated API', 'API-equivalent cost / run (USD, list price)', 'Docs calls / run']);
  for (const run of runs) {
    for (const a of armsOf(run.scores)) {
      const m = docsArmMetrics(run.scores.filter((s) => s.arm === a));
      row([
        modelName(run.model), label(a), `**${m.current} / ${m.runs}**`, wilsonTxt(m.current, m.runs), `[${pct(m.currentCi[0], 1)}, ${pct(m.currentCi[1], 1)}]`,
        `${m.works} / ${m.runs}`, `${m.versionOk} / ${m.runs}`, `${m.requiredOk} / ${m.runs}`, String(m.removed), String(m.deprecated), f3(m.costMean), f1(m.docsCallsMean),
      ]);
    }
  }
  L.push('');
}

for (const run of runs) {
  const { scores } = run;
  const name = modelName(run.model);
  const arms = armsOf(scores);
  const by = (a: string) => scores.filter((s) => s.arm === a);
  const M = Object.fromEntries(arms.map((a) => [a, docsArmMetrics(by(a))]));
  type Mx = (typeof M)[string];
  L.push(`### ${name} (\`${run.model}\`, run \`${run.stamp}\`)`, '');
  head(['Metric', ...arms.map(label)]);
  const metric = (n: string, f: (m: Mx) => string) => row([n, ...arms.map((a) => f(M[a]))]);
  metric('**Current API** (works, right major, every check passes)', (m) => `**${m.current} / ${m.runs}** (${pct(m.current, m.runs)} [${pct(m.currentCi[0], 1)}, ${pct(m.currentCi[1], 1)}])`);
  metric('Works (installs, builds, smoke test passes)', (m) => `${m.works} / ${m.runs}`);
  metric('Installs', (m) => `${m.installed} / ${m.runs}`);
  metric('Builds / type-checks / imports', (m) => `${m.built} / ${m.runs}`);
  if (smokeTasks) metric(`Smoke test passes (${smokeTasks} tasks with one)`, (m) => `${m.smokePass} / ${m.smokeRuns}`);
  metric(TASKS.some((t) => t.majors.some((x) => x.min)) ? 'Pinned the asked major, at or above the first release with the API' : 'Pinned the asked major', (m) => `${m.versionOk} / ${m.runs}`);
  metric('All required new-API checks present', (m) => `${m.requiredOk} / ${m.runs}`);
  metric('Runs using a removed API', (m) => String(m.removed));
  metric('Runs using a deprecated API', (m) => String(m.deprecated));
  metric('API checks passed (all kinds)', (m) => pct(m.checksPassed, m.checksAll));
  metric('API-equivalent cost per run (USD, list price, mean)', (m) => f3(m.costMean));
  metric('API-equivalent cost, all runs of the arm (USD, list price)', (m) => f2(m.costSum));
  metric('Turns per run (mean)', (m) => f1(m.turns));
  metric('Duration per run (s, mean)', (m) => f1(m.durationS));
  metric('MCP calls per run (mean)', (m) => f1(m.mcpCalls));
  metric('Docs calls per run (mean)', (m) => f1(m.docsCallsMean));
  metric('Docs returned per run (k chars, mean)', (m) => f1(m.docsKChars));
  L.push('');

  L.push(`#### Per task, ${name}`, '', 'Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used, v = wrong major pinned).', '');
  head(['Task', ...arms.map(label)]);
  for (const t of TASKS) {
    row([`${t.id} (${t.library})`, ...arms.map((a) => {
      const rs = scores.filter((s) => s.arm === a && s.task === t.id);
      if (!rs.length) return '';
      const fails = new Map<string, number>();
      for (const r of rs) {
        for (const c of r.checks.filter((x) => !x.pass)) {
          const k = `${{ required: 'r', removed: 'x', deprecated: 'd' }[c.kind]}:${c.id}`;
          fails.set(k, (fails.get(k) ?? 0) + 1);
        }
        if (!r.versionOk) {
          const k = `v:${Object.entries(r.pinnedVersion ?? r.pinned).map(([n, v]) => `${n}@${v ?? '?'}`).join(',')}`;
          fails.set(k, (fails.get(k) ?? 0) + 1);
        }
      }
      const f = [...fails.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
      return `**${rs.filter((r) => r.current).length}** / ${rs.filter((r) => r.works).length} / ${rs.filter((r) => r.build?.built).length} of ${rs.length}${f ? `<br>${f}` : ''}`;
    })]);
  }
  L.push('');

  L.push(`#### Runs that do not work, ${name}`, '');
  for (const a of arms) {
    const bad = by(a).filter((r) => !r.works);
    L.push(`**${label(a)}**: ${bad.length ? '' : 'none'}`, '');
    for (const r of bad) {
      const b = r.build;
      const why = !b?.installed
        ? `install failed: ${b?.error ?? ''}`
        : !b.built
          ? `${b.step} failed: ${b.error ?? ''}`
          : `smoke: ${r.smoke?.error ?? r.smoke?.tests.filter((x) => !x.pass).map((x) => `${x.name}${x.got ? ` (${x.got})` : x.error ? ` (${x.error})` : ''}`).join('; ')}`;
      L.push(`- ${r.task} r${r.rep}: \`${why.replace(/\s*\(?[A-Z]:\\[^\s)]*\)?/g, '').replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 220)}\``);
    }
    L.push('');
  }

  L.push(`#### Docs tool usage, ${name}`, '');
  head(['Arm', 'Calls by tool (total over all runs)', 'get-docs answers with no matching docs']);
  for (const a of arms.filter((x) => x !== 'no-docs')) {
    const calls = by(a).flatMap((r) => r.calls);
    const tools = new Map<string, number>();
    for (const c of calls) tools.set(c.tool, (tools.get(c.tool) ?? 0) + 1);
    const q = calls.filter((c) => /(get|query)-docs$/.test(c.tool));
    row([
      label(a),
      [...tools.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'none',
      a.startsWith('pinright') || a === 'docs-only' ? String(q.filter((c) => /^No documentation found/m.test(c.result ?? '')).length) : 'n/a',
    ]);
  }
  L.push('');
}

const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';
const fileArg = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : undefined;
const file = fileArg ? (isAbsolute(fileArg) ? fileArg : resolve(fileArg)) : join(root, 'bench', set === DEFAULT_SET ? 'DOCS.md' : `RESULTS-${set}.md`);
const prev = existsSync(file) ? readFileSync(file, 'utf8') : `# Docs benchmark\n\n${START}\n${END}\n`;
const i = prev.indexOf(START);
const j = prev.indexOf(END);
const out = i >= 0 && j > i ? `${prev.slice(0, i + START.length)}\n${L.join('\n')}\n${prev.slice(j)}` : `${prev}\n${START}\n${L.join('\n')}\n${END}\n`;
writeFileSync(file, out);
console.log(`wrote ${file}`);
