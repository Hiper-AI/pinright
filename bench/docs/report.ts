/**
 * Turns runs/<stamp>/scores.json into the generated part of bench/DOCS.md
 * (between the "generated" markers; the hand-written diagnosis around it is kept).
 *
 *   npx tsx bench/docs/report.ts <stamp>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARMS, type DocsRunScore } from './score.js';
import { TASKS } from './tasks.js';

const stamp = process.argv[2];
if (!stamp) throw new Error('usage: report.ts <stamp>');
const root = resolve(import.meta.dirname, '..', '..');
const runDir = join(root, 'bench', 'docs', 'runs', stamp);
const scores: DocsRunScore[] = JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'));

const LABEL: Record<string, string> = { 'no-docs': 'No docs', safectx: 'safectx' };
const label = (a: string) => LABEL[a] ?? a;
const arms = [...ARMS.filter((a) => scores.some((s) => s.arm === a)), ...[...new Set(scores.map((s) => s.arm))].filter((a) => !ARMS.includes(a)).sort()];
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const docsCalls = (s: DocsRunScore) => s.calls.filter((c) => /(get|query)-docs|upgrade-guide/.test(c.tool));

const L: string[] = [];
const row = (cells: string[]) => L.push(`| ${cells.join(' | ')} |`);
const head = (cells: string[]) => {
  row(cells);
  L.push(`|${cells.map(() => '---').join('|')}|`);
};

const models = [...new Set(scores.map((s) => s.model).filter(Boolean))];
L.push(
  `Run \`${stamp}\`, model \`${models.join(', ') || config.model}\`, ${config.reps} repetitions of ${TASKS.length} tasks per arm, ${scores.length} runs scored.`,
  '',
);
head(['Metric', ...arms.map((a) => label(a))]);
const by = (a: string) => scores.filter((s) => s.arm === a);
const metric = (name: string, f: (rs: DocsRunScore[]) => string) => row([name, ...arms.map((a) => f(by(a)))]);
metric('**Current API** (works, right major, every check passes)', (rs) => `**${rs.filter((r) => r.current).length} / ${rs.length}** (${pct(rs.filter((r) => r.current).length, rs.length)})`);
metric('Works (installs, builds, smoke test passes)', (rs) => `${rs.filter((r) => r.works).length} / ${rs.length}`);
metric('Installs', (rs) => `${rs.filter((r) => r.build?.installed).length} / ${rs.length}`);
metric('Builds / type-checks / imports', (rs) => `${rs.filter((r) => r.build?.built).length} / ${rs.length}`);
metric('Smoke test passes (6 tasks with one)', (rs) => {
  const w = rs.filter((r) => TASKS.find((t) => t.id === r.task)?.smoke);
  return `${w.filter((r) => r.smoke?.pass).length} / ${w.length}`;
});
metric('Pinned the asked major', (rs) => `${rs.filter((r) => r.versionOk).length} / ${rs.length}`);
metric('All required new-API checks present', (rs) => `${rs.filter((r) => r.checks.filter((c) => c.kind === 'required').every((c) => c.pass)).length} / ${rs.length}`);
metric('Runs using a removed API', (rs) => String(rs.filter((r) => r.checks.some((c) => c.kind === 'removed' && !c.pass)).length));
metric('Runs using a deprecated API', (rs) => String(rs.filter((r) => r.checks.some((c) => c.kind === 'deprecated' && !c.pass)).length));
metric('API checks passed (all kinds)', (rs) => {
  const all = rs.flatMap((r) => r.checks);
  return pct(all.filter((c) => c.pass).length, all.length);
});
metric('Cost per run (USD, mean)', (rs) => f2(mean(rs.map((r) => r.costUsd ?? NaN).filter(Number.isFinite))));
metric('Turns per run (mean)', (rs) => f1(mean(rs.map((r) => r.turns ?? NaN).filter(Number.isFinite))));
metric('Duration per run (s, mean)', (rs) => f1(mean(rs.map((r) => (r.durationMs ?? NaN) / 1000).filter(Number.isFinite))));
metric('MCP calls per run (mean)', (rs) => f1(mean(rs.map((r) => r.calls.length))));
metric('Docs calls per run (mean)', (rs) => f1(mean(rs.map((r) => docsCalls(r).length))));
metric('Docs returned per run (k chars, mean)', (rs) => f1(mean(rs.map((r) => docsCalls(r).reduce((a, c) => a + c.resultChars, 0) / 1000))));
L.push('');

L.push('### Per task', '', 'Each cell: runs with the current API / runs that work (build + smoke test) / runs that build, out of the repetitions. Failed checks follow, with how many runs failed each (r = required missing, x = removed API used, d = deprecated API used).', '');
head(['Task', ...arms.map((a) => label(a))]);
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
      if (!r.versionOk) fails.set(`v:${Object.entries(r.pinned).map(([k, v]) => `${k}@${v ?? '?'}`).join(',')}`, (fails.get(`v:${Object.entries(r.pinned).map(([k, v]) => `${k}@${v ?? '?'}`).join(',')}`) ?? 0) + 1);
    }
    const f = [...fails.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
    return `**${rs.filter((r) => r.current).length}** / ${rs.filter((r) => r.works).length} / ${rs.filter((r) => r.build?.built).length} of ${rs.length}${f ? `<br>${f}` : ''}`;
  })]);
}
L.push('');

L.push('### Runs that do not work', '');
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

L.push('### Docs tool usage', '');
head(['Arm', 'Calls by tool (total over all runs)', 'get-docs answers with no matching docs']);
for (const a of arms.filter((x) => x !== 'no-docs')) {
  const calls = by(a).flatMap((r) => r.calls);
  const tools = new Map<string, number>();
  for (const c of calls) tools.set(c.tool, (tools.get(c.tool) ?? 0) + 1);
  const q = calls.filter((c) => /(get|query)-docs$/.test(c.tool));
  row([
    label(a),
    [...tools.entries()].map(([k, n]) => `${k} ${n}`).join(', '),
    a.startsWith('safectx') ? String(q.filter((c) => /^No documentation found/m.test(c.result ?? '')).length) : 'n/a',
  ]);
}
L.push('');

const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';
const file = join(root, 'bench', 'DOCS.md');
const prev = existsSync(file) ? readFileSync(file, 'utf8') : `# Docs benchmark\n\n${START}\n${END}\n`;
const i = prev.indexOf(START);
const j = prev.indexOf(END);
const out = i >= 0 && j > i ? `${prev.slice(0, i + START.length)}\n${L.join('\n')}\n${prev.slice(j)}` : `${prev}\n${START}\n${L.join('\n')}\n${END}\n`;
writeFileSync(file, out);
console.log(L.join('\n'));
