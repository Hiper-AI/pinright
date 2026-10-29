/**
 * What a CI run shows without code scanning: a Markdown job summary (a counts
 * table and the worst findings) and workflow-command annotations, which GitHub
 * renders on the PR diff even when the repository has no code scanning.
 */
import type { SarifLog } from './build.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- SARIF objects are plain JSON */
interface Row {
  level: string;
  score?: number;
  ruleId: string;
  message: string;
  file: string;
  line: number;
  column?: number;
  endColumn?: number;
}

export function sarifRows(log: SarifLog): Row[] {
  const run = log.runs[0];
  const rules = new Map<string, any>((run?.tool?.driver?.rules ?? []).map((r: any) => [r.id, r]));
  return (run?.results ?? []).map((r: any) => {
    const loc = r.locations?.[0]?.physicalLocation;
    const score = Number(rules.get(r.ruleId)?.properties?.['security-severity']);
    return {
      level: r.level ?? 'warning',
      score: Number.isFinite(score) ? score : undefined,
      ruleId: r.ruleId,
      message: r.message?.text ?? '',
      file: decodeURIComponent(loc?.artifactLocation?.uri ?? ''),
      line: loc?.region?.startLine ?? 1,
      column: loc?.region?.startColumn,
      endColumn: loc?.region?.endColumn,
    };
  });
}

const bucket = (r: Row) =>
  r.score === undefined ? (r.level === 'error' ? 'high' : r.level === 'warning' ? 'unrated' : 'note')
  : r.score >= 9 ? 'critical' : r.score >= 7 ? 'high' : r.score >= 4 ? 'medium' : 'low';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const rank = (r: Row) => (r.score ?? (r.level === 'error' ? 7 : r.level === 'warning' ? 4 : 0));

export function summaryMarkdown(log: SarifLog, opts: { exitCode: number; failOn: string; sarifFile?: string; uploaded?: boolean; max?: number }): string {
  const rows = sarifRows(log);
  const max = opts.max ?? 20;
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, unrated: 0, note: 0 };
  for (const r of rows) counts[bucket(r)]++;
  const verdict = opts.exitCode === 0 ? 'passed' : opts.exitCode === 1 ? 'failed' : 'could not run';
  const out = [
    `### safectx audit ${verdict}`,
    '',
    `${rows.length} finding${rows.length === 1 ? '' : 's'}; fails on \`${opts.failOn}\` and above, malware, typosquats and policy denials.`,
    '',
    '| Critical | High | Medium | Low | Unrated | Notes |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ${counts.unrated} | ${counts.note} |`,
  ];
  if (rows.length) {
    const top = [...rows].sort((a, b) => rank(b) - rank(a)).slice(0, max);
    out.push('', '| Severity | Rule | Where | Finding |', '| --- | --- | --- | --- |');
    for (const r of top) out.push(`| ${bucket(r)} | \`${cell(r.ruleId)}\` | \`${cell(r.file)}:${r.line}\` | ${cell(r.message)} |`);
    if (rows.length > top.length) out.push('', `... and ${rows.length - top.length} more.`);
  }
  if (opts.sarifFile) out.push('', `SARIF: \`${opts.sarifFile}\`${opts.uploaded ? ', uploaded to code scanning by the next step' : ''}.`);
  return `${out.join('\n')}\n`;
}

const escData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s: string) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * `::error file=...,line=...::message` lines, worst first. GitHub shows at most
 * 10 errors and 10 warnings per step, so more would only be noise in the log.
 */
export function annotations(log: SarifLog, max = 10): string[] {
  const rows = [...sarifRows(log)].sort((a, b) => rank(b) - rank(a));
  const out: string[] = [];
  const used: Record<string, number> = { error: 0, warning: 0, notice: 0 };
  for (const r of rows) {
    const cmd = r.level === 'error' ? 'error' : r.level === 'warning' ? 'warning' : 'notice';
    if (used[cmd] >= max) continue;
    used[cmd]++;
    const props = [`file=${escProp(r.file)}`, `line=${r.line}`, ...(r.column ? [`col=${r.column}`] : []), ...(r.endColumn ? [`endColumn=${r.endColumn}`] : []), `title=${escProp(`safectx ${r.ruleId}`)}`];
    out.push(`::${cmd} ${props.join(',')}::${escData(r.message)}`);
  }
  return out;
}
