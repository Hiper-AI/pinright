/**
 * What a CI run shows without code scanning: a Markdown job summary (a counts
 * table and the worst findings) and workflow-command annotations, which GitHub
 * renders on the PR diff even when the repository has no code scanning.
 */
import { randomUUID } from 'node:crypto';
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

// Rule ids, paths and messages come from lockfiles and advisories: in the summary they are text, never
// HTML, links or images (a package named "[all clear](https://evil)" or "<img src=...>").
const cell = (s: string) =>
  s
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]()!|~])/g, '\\$1');
/** Inside a code span backslash escapes do not apply: only the span's delimiter and the table's pipe need care. */
const code = (s: string) => `\`${s.replace(/\r?\n/g, ' ').replace(/`/g, "'").replace(/\|/g, '\\|')}\``;

/** Findings that fail the run at any fail-on level: they go first, or a long advisory list hides why the step failed. */
const FAILS_ALWAYS = new Set(['pinright/malware', 'pinright/typosquat', 'pinright/policy-deny', 'pinright/policy-license', 'pinright/action-missing-ref']);
const rank = (r: Row) => (FAILS_ALWAYS.has(r.ruleId) ? 11 : (r.score ?? (r.level === 'error' ? 7 : r.level === 'warning' ? 4 : 0)));

export function summaryMarkdown(log: SarifLog, opts: { exitCode: number; failOn: string; sarifFile?: string; uploaded?: boolean; max?: number }): string {
  const rows = sarifRows(log);
  const max = opts.max ?? 20;
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, unrated: 0, note: 0 };
  for (const r of rows) counts[bucket(r)]++;
  const verdict = opts.exitCode === 0 ? 'passed' : opts.exitCode === 1 ? 'failed' : 'could not run';
  const out = [
    `### pinright audit ${verdict}`,
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
    for (const r of top) out.push(`| ${bucket(r)} | ${code(r.ruleId)} | ${code(`${r.file}:${r.line}`)} | ${cell(r.message)} |`);
    if (rows.length > top.length) out.push('', `... and ${rows.length - top.length} more.`);
  }
  if (opts.sarifFile) out.push('', `SARIF: \`${opts.sarifFile}\`${opts.uploaded ? ', uploaded to code scanning by the next step' : ''}.`);
  return `${out.join('\n')}\n`;
}

export const escData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
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
    const props = [`file=${escProp(r.file)}`, `line=${r.line}`, ...(r.column ? [`col=${r.column}`] : []), ...(r.endColumn ? [`endColumn=${r.endColumn}`] : []), `title=${escProp(`pinright ${r.ruleId}`)}`];
    out.push(`::${cmd} ${props.join(',')}::${escData(r.message)}`);
  }
  return out;
}

/**
 * Text that carries package names, advisory titles or file paths, for a GitHub
 * Actions log. The runner executes any line starting with "::" as a workflow
 * command, and a lockfile key or an advisory can hold a newline: fenced between
 * stop-commands and a random resume token, no line of it is run (no
 * ::add-mask::, ::stop-commands:: or forged ::error:: from package data).
 * Outside Actions the text is returned as is.
 */
export function fenceCommands(text: string, opts: { actions?: boolean; token?: string } = {}): string {
  if (!(opts.actions ?? process.env.GITHUB_ACTIONS === 'true')) return text;
  const token = opts.token ?? randomUUID().replace(/-/g, '');
  return `::stop-commands::${token}\n${text.split(token).join('[token]')}\n::${token}::`;
}
