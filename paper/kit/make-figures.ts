/**
 * Draws the paper kit's figures from the CSVs in paper/kit/data, as SVG (light and dark) and,
 * when a local Chrome or Edge is found, PNG at 2x. No dependencies beyond Node.
 *
 *   npx tsx paper/kit/make-figures.ts [--no-png]
 *
 * Output: paper/kit/figures/<id>.svg|png (light) and <id>-dark.svg|png. Captions and alt text
 * are hand-written next to them (figures/<id>.caption.md, copy/alt-text.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AFTER, ARM_COLOR, ARM_SHORT, BEFORE, barRight, barUp, errV, legend, MONO, type Mode, pngFromSvg, r, SANS, svgDoc, terminal, text, THEME,
} from './svg.js';

const here = import.meta.dirname;
const dataDir = join(here, 'data');
const figDir = join(here, 'figures');
mkdirSync(figDir, { recursive: true });
const wantPng = !process.argv.includes('--no-png');

// ------------------------------------------------------------------ CSV
function readCsv(name: string): Record<string, string>[] {
  const text = readFileSync(join(dataDir, name), 'utf8');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const num = (s: string) => Number(s);

const written: string[] = [];
function emit(id: string, mode: Mode, w: number, h: number, svg: string) {
  const base = mode === 'light' ? id : `${id}-dark`;
  const svgPath = join(figDir, `${base}.svg`);
  writeFileSync(svgPath, svg);
  written.push(`${base}.svg`);
  if (wantPng) {
    if (pngFromSvg(svgPath, join(figDir, `${base}.png`), w, h)) written.push(`${base}.png`);
    else console.warn(`no PNG for ${base}: no local Chrome or Edge (set PINRIGHT_KIT_BROWSER)`);
  }
}

const MODELS = ['Sonnet 5.5', 'Haiku 5.5', 'Opus 5.5'];
const AGENT_ARMS = ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest'];
const agents = readCsv('agents_by_model_arm.csv');
const agentRow = (model: string, arm: string) => agents.find((x) => x.model === model && x.arm === arm)!;

function header(mode: Mode, title: string, sub: string, w: number) {
  const t = THEME[mode];
  return [text(32, 40, title, { size: 19, weight: 650, fill: t.ink }), text(32, 64, sub, { size: 13.5, fill: t.ink2 })].join('\n') + (w ? '' : '');
}
/** Source line(s) at the bottom, wrapped to the figure width (about 6.1 px per character at 11.5 px). */
function footer(mode: Mode, s: string, h: number, w = 1040) {
  const max = Math.floor((w - 64) / 6.1);
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    if (cur && (cur + ' ' + word).length > max) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => text(32, h - 18 - (lines.length - 1 - i) * 16, l, { size: 11.5, fill: THEME[mode].muted })).join('\n');
}
function yAxis(mode: Mode, x0: number, x1: number, y0: number, ph: number, max: number, ticks: number[], fmt: (v: number) => string) {
  const t = THEME[mode];
  const out: string[] = [];
  for (const v of ticks) {
    const y = y0 + ph - (v / max) * ph;
    out.push(`<line x1="${r(x0)}" x2="${r(x1)}" y1="${r(y)}" y2="${r(y)}" stroke="${v === 0 ? t.axis : t.grid}" stroke-width="1"/>`);
    out.push(text(x0 - 8, y + 4, fmt(v), { size: 12, fill: t.muted, anchor: 'end', font: SANS }));
  }
  return out.join('\n');
}

/**
 * Grouped vertical bars: one group per category, one bar per series, optional 95% interval
 * and a label above each bar.
 */
function groupedBars(o: {
  mode: Mode; x: number; y: number; w: number; h: number; groups: string[]; series: string[];
  value: (g: string, s: string) => number | undefined; ci?: (g: string, s: string) => [number, number] | undefined;
  label?: (g: string, s: string) => string; color: (s: string) => string; outline?: (s: string) => string | undefined;
  max: number; ticks: number[]; tickFmt: (v: number) => string; panelTitle?: string; clipNote?: (g: string, s: string) => string | undefined;
}) {
  const t = THEME[o.mode];
  const out: string[] = [];
  const left = o.x + 44;
  const pw = o.w - 44;
  const top = o.y + (o.panelTitle ? 26 : 0);
  const ph = o.h - (o.panelTitle ? 26 : 0) - 30;
  if (o.panelTitle) out.push(text(left, o.y + 12, o.panelTitle, { size: 13.5, weight: 600, fill: t.ink }));
  out.push(yAxis(o.mode, left, left + pw, top, ph, o.max, o.ticks, o.tickFmt));
  const gw = pw / o.groups.length;
  const n = o.series.filter((s) => o.groups.some((g) => o.value(g, s) !== undefined)).length;
  const bw = Math.min(30, (gw * 0.82) / n - 2);
  o.groups.forEach((g, gi) => {
    const present = o.series.filter((s) => o.value(g, s) !== undefined);
    const total = present.length * (bw + 2) - 2;
    let bx = left + gi * gw + (gw - total) / 2;
    for (const s of present) {
      const v = o.value(g, s)!;
      const vh = (Math.min(v, o.max) / o.max) * ph;
      out.push(`<g><title>${g}, ${s}: ${o.label ? o.label(g, s) : v}</title>${barUp(bx, top + ph - vh, bw, vh, o.color(s), o.outline?.(s))}</g>`);
      const ci = o.ci?.(g, s);
      let labelTop = top + ph - vh;
      if (ci) {
        const y1 = top + ph - (Math.min(ci[1], o.max) / o.max) * ph;
        const y2 = top + ph - (Math.min(ci[0], o.max) / o.max) * ph;
        out.push(errV(bx + bw / 2, y1, y2, t.ink2));
        labelTop = Math.min(labelTop, y1);
      }
      if (o.label) out.push(text(bx + bw / 2, labelTop - 6, o.label(g, s), { size: 11, fill: t.ink2, anchor: 'middle' }));
      const note = o.clipNote?.(g, s);
      if (note) out.push(text(bx + bw / 2, top - 2, note, { size: 11, fill: t.ink2, anchor: 'middle' }));
      bx += bw + 2;
    }
    out.push(text(left + gi * gw + gw / 2, top + ph + 22, g, { size: 13, fill: t.ink, anchor: 'middle', weight: 600 }));
  });
  return out.join('\n');
}

const armLegend = (mode: Mode, arms: string[]) =>
  arms.map((a) => ({ label: ARM_SHORT[a], color: ARM_COLOR[mode][a], outline: a === 'latest' ? THEME[mode].axis : undefined }));
const armOutline = (mode: Mode) => (a: string) => (a === 'latest' ? THEME[mode].axis : undefined);

// ------------------------------------------------------------------ (a) alerts per project
function figA(mode: Mode) {
  const W = 1240, H = 600;
  const t = THEME[mode];
  const val = (g: string, a: string) => num(agentRow(g, a).alerts_per_project_mean);
  const ci = (g: string, a: string): [number, number] => [num(agentRow(g, a).alerts_per_project_ci95_lo), num(agentRow(g, a).alerts_per_project_ci95_hi)];
  const lab = (g: string, a: string) => val(g, a).toFixed(1);
  const lg = legend(32, 100, armLegend(mode, AGENT_ARMS), mode, W - 64);
  const body = [
    header(mode, 'Whole-tree alerts per project', 'Mean npm audit / pip-audit alerts per generated project, 12 tasks x 2 runs, with 95% cluster-bootstrap intervals (tasks resampled). Run v7, 2026-11-02, 1.0.0 code.', W),
    lg.svg,
    groupedBars({ mode, x: 32, y: 140, w: 600, h: 400, groups: MODELS, series: AGENT_ARMS, value: val, ci, label: lab, color: (a) => ARM_COLOR[mode][a], outline: armOutline(mode), max: 50, ticks: [0, 10, 20, 30, 40, 50], tickFmt: String, panelTitle: 'All arms (0 to 50)' }),
    groupedBars({ mode, x: 660, y: 140, w: 548, h: 400, groups: MODELS, series: AGENT_ARMS.filter((a) => a !== 'no-docs'), value: val, ci, label: lab, color: (a) => ARM_COLOR[mode][a], outline: armOutline(mode), max: 12, ticks: [0, 2, 4, 6, 8, 10, 12], tickFmt: String, panelTitle: 'Same data without "No docs" (0 to 12)' }),
    `<line x1="646" x2="646" y1="150" y2="540" stroke="${t.grid}"/>`,
    footer(mode, 'Source: bench/RESULTS-v7.md, paper/kit/data/agents_by_model_arm.csv. "No pin" installs the no-docs packages without a version (1 run per task). The 0.3 left in the MCP arms is nuxt’s (no fixed release, same in "No pin"); hook only adds next 15.5.28’s postcss.', H, W),
  ].join('\n');
  emit('fig-a-alerts-per-project', mode, W, H, svgDoc(W, H, mode, 'Whole-tree alerts per project by arm and model', 'Grouped bars: no docs about 30 alerts per project for each model; docs-only 3.5 (Sonnet), 2.6 (Haiku), 0.3 (Opus); pinright MCP and MCP + hook 0.3; hook only 0.6; no-pin reference 0.3.', body));
}

// ------------------------------------------------------------------ (b) % direct deps with advisories
function figB(mode: Mode) {
  const W = 1040, H = 560;
  const val = (g: string, a: string) => num(agentRow(g, a).direct_deps_with_advisory_pct);
  const ci = (g: string, a: string): [number, number] => [num(agentRow(g, a).direct_deps_with_advisory_pct_ci95_lo), num(agentRow(g, a).direct_deps_with_advisory_pct_ci95_hi)];
  const lab = (g: string, a: string) => `${Math.round(val(g, a))}%`;
  const lg = legend(32, 100, armLegend(mode, AGENT_ARMS), mode, W - 64);
  const body = [
    header(mode, 'Direct dependencies pinned with a known advisory', 'Share of the direct dependencies the agent pinned that had at least one OSV advisory, with 95% cluster-bootstrap intervals. Run v7, 2026-11-02, 1.0.0 code.', W),
    lg.svg,
    groupedBars({ mode, x: 32, y: 150, w: W - 64, h: 360, groups: MODELS, series: AGENT_ARMS, value: val, ci, label: lab, color: (a) => ARM_COLOR[mode][a], outline: armOutline(mode), max: 60, ticks: [0, 10, 20, 30, 40, 50, 60], tickFmt: (v) => `${v}%` }),
    footer(mode, 'Source: bench/AGENTS.md, paper/kit/data/agents_by_model_arm.csv (direct_deps_with_advisory_pct). docs-only: Sonnet 2 of 125, Haiku 3 of 142, Opus 0 of 126.', H),
  ].join('\n');
  emit('fig-b-direct-deps-with-advisories', mode, W, H, svgDoc(W, H, mode, 'Share of pinned direct dependencies with a known advisory', 'No docs: 40% Sonnet, 40% Haiku, 42% Opus. docs-only: 2%, 2%, 0%. All three pinright arms and the no-pin reference: 0% for every model.', body));
}

// ------------------------------------------------------------------ (c) docs benchmark
function figC(mode: Mode) {
  const docs = readCsv('docs_by_model_arm.csv');
  const row = (g: string, a: string) => docs.find((x) => x.model === g && x.arm === a);
  const W = 1000, H = 540;
  const ARMS = ['no-docs', 'docs-only', 'pinright'];
  const val = (g: string, a: string) => (row(g, a) ? num(row(g, a)!.current_api_pct) : undefined);
  const ci = (g: string, a: string): [number, number] | undefined => (row(g, a) ? [num(row(g, a)!.current_api_pct_ci95_lo), num(row(g, a)!.current_api_pct_ci95_hi)] : undefined);
  const lab = (g: string, a: string) => `${row(g, a)!.current_api_runs}/${row(g, a)!.runs}`;
  const lg = legend(32, 100, [
    { label: ARM_SHORT['no-docs'], color: ARM_COLOR[mode]['no-docs'] },
    { label: 'docs-only', color: ARM_COLOR[mode]['docs-only'] },
    { label: 'pinright', color: ARM_COLOR[mode].pinright },
  ], mode, W - 64);
  const body = [
    header(mode, 'Docs benchmark: runs that wrote the current API', '8 tasks whose library changed API in its current major, 2 runs each. Bars: share of runs current; labels: runs; whiskers: 95% interval (tasks resampled).', W),
    lg.svg,
    groupedBars({ mode, x: 32, y: 140, w: W - 64, h: 350, groups: MODELS, series: ARMS, value: val, ci, label: lab, color: (a) => ARM_COLOR[mode][a], max: 100, ticks: [0, 25, 50, 75, 100], tickFmt: (v) => `${v}%` }),
    footer(mode, 'Source: bench/DOCS.md, paper/kit/data/docs_by_model_arm.csv. "Current" = installs, builds, passes the smoke test, pins the asked major, uses every new API and no removed or deprecated one.', H),
  ].join('\n');
  emit('fig-c-docs-current-api', mode, W, H, svgDoc(W, H, mode, 'Docs benchmark: current-API runs by model', 'No docs: Sonnet 13 of 16, Haiku 9 of 16, Opus 14 of 16. docs-only: 16, 15 and 16 of 16. pinright: 16 of 16 for every model.', body));
}

// ------------------------------------------------------------------ (d) retrieval probes
function figD(mode: Mode) {
  const probes = readCsv('probes.csv');
  const W = 1000, H = 540;
  const groups = probes.map((p) => p.set);
  const S = ['before', 'after'];
  const p = (g: string) => probes.find((x) => x.set === g)!;
  const val = (g: string, s: string) => (100 * num(s === 'before' ? p(g).before : p(g).v6_rerun_2026_11_01)) / num(p(g).questions);
  const lab = (g: string, s: string) => `${s === 'before' ? p(g).before : p(g).v6_rerun_2026_11_01}/${p(g).questions}`;
  const lg = legend(32, 100, [
    { label: 'Before tuning (first score of each set)', color: BEFORE[mode] },
    { label: 'Release candidate, rerun 2026-11-01', color: AFTER[mode] },
  ], mode, W - 64);
  const body = [
    header(mode, 'Retrieval probes: answers that show the current API', 'pinright’s docs pipeline without an agent. Sets B and C were not looked at while tuning; set A was; the original set covers the benchmark tasks.', W),
    lg.svg,
    groupedBars({ mode, x: 32, y: 140, w: W - 64, h: 350, groups: groups.map((g) => g.replace('Held-out ', 'Held-out ')), series: S, value: val, label: lab, color: (s) => (s === 'before' ? BEFORE[mode] : AFTER[mode]), max: 100, ticks: [0, 25, 50, 75, 100], tickFmt: (v) => `${v}%` }),
    footer(mode, 'Source: bench/DOCS.md; paper/kit/data/probes.csv. Before = e644213 (original), dd570aa (A, B), d2f082a (C). A probe checks for strings of the current API, not for a correct answer.', H),
  ].join('\n');
  emit('fig-d-retrieval-probes', mode, W, H, svgDoc(W, H, mode, 'Retrieval probe scores before and after tuning', 'Original 16 to 24 of 25; held-out A 53 to 75 of 81; held-out B 22 to 25 of 28 (untouched); held-out C 28 to 33 of 45 (untouched).', body));
}

// ------------------------------------------------------------------ (e) hook false positives by source
function figE(mode: Mode) {
  const t = THEME[mode];
  const rows = readCsv('fp_by_source.csv').filter((x) => !x.source.startsWith('All sources'));
  const W = 1040, rowH = 54, top = 150;
  const H = top + rows.length * rowH + 70;
  const labelW = 250, x0 = 32 + labelW, pw = W - x0 - 90, max = 8;
  const out: string[] = [header(mode, 'Hook false positives on public commands, by source', '25,077 commands and manifest writes from 180 public repositories, replayed through the real hook. Share blocked or asked, without ${{ }} templating.', W)];
  out.push(legend(32, 100, [{ label: 'Baseline (1.0.0 RC)', color: BEFORE[mode] }, { label: 'After the false-positive fixes', color: AFTER[mode] }], mode).svg);
  for (const v of [0, 2, 4, 6, 8]) {
    const x = x0 + (v / max) * pw;
    out.push(`<line x1="${r(x)}" x2="${r(x)}" y1="${top - 10}" y2="${top + rows.length * rowH}" stroke="${v === 0 ? t.axis : t.grid}"/>`);
    out.push(text(x, top + rows.length * rowH + 18, `${v}%`, { size: 12, fill: t.muted, anchor: 'middle' }));
  }
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    out.push(text(32, y + 20, row.source, { size: 13, fill: t.ink, weight: 600 }));
    out.push(text(32, y + 38, `${Number(row.entries).toLocaleString('en-US')} entries`, { size: 11.5, fill: t.muted }));
    const b = num(row.blocked_or_asked_pct_baseline), a = num(row.blocked_or_asked_pct_after_fixes);
    out.push(`<g><title>${row.source}, baseline: ${b}%</title>${barRight(x0, y + 6, (b / max) * pw, 16, BEFORE[mode])}</g>`);
    out.push(text(x0 + (b / max) * pw + 6, y + 19, `${b.toFixed(2)}%`, { size: 11.5, fill: t.ink2 }));
    out.push(`<g><title>${row.source}, after: ${a}%</title>${barRight(x0, y + 25, (a / max) * pw, 16, AFTER[mode])}</g>`);
    out.push(text(x0 + (a / max) * pw + 6, y + 38, `${a.toFixed(2)}%`, { size: 11.5, fill: t.ink2 }));
  });
  out.push(footer(mode, 'Source: bench/fp/RESULTS.md; paper/kit/data/fp_by_source.csv. All entries: 2.22% to 1.44% (1.46% on top of the second security review). Most remaining asks are by design (versions or paths in variables).', H));
  emit('fig-e-hook-false-positives', mode, W, H, svgDoc(W, H, mode, 'Hook false-positive rate by source, before and after fixes', rows.map((x) => `${x.source}: ${x.blocked_or_asked_pct_baseline}% to ${x.blocked_or_asked_pct_after_fixes}%`).join('; '), out.join('\n')));
}

// ------------------------------------------------------------------ (f) hook latency
function figF(mode: Mode) {
  const t = THEME[mode];
  const all = readCsv('latency.csv');
  const rows = [all[0], all[1], all[2]];
  const names = ['Command that installs nothing (npm test)', 'One install, warm cache', 'One install, cold cache'];
  const W = 1040, rowH = 74, top = 150;
  const H = top + rows.length * rowH + 74;
  const x0 = 330, pw = W - x0 - 60;
  const lo = Math.log10(50), hi = Math.log10(10000);
  const X = (ms: number) => x0 + ((Math.log10(ms) - lo) / (hi - lo)) * pw;
  const out: string[] = [header(mode, 'Hook latency', 'p50 bar and p95 whisker, 5 runs per case, live services (Windows, Node 24). The dashed tick is the budget. Log scale.', W)];
  out.push(legend(32, 100, [{ label: 'p50', color: AFTER[mode] }, { label: 'p95 (whisker)', color: t.ink2 }, { label: 'Budget', color: ARM_COLOR[mode]['docs-only'] }], mode).svg);
  for (const v of [50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
    const x = X(v);
    out.push(`<line x1="${r(x)}" x2="${r(x)}" y1="${top - 10}" y2="${top + rows.length * rowH}" stroke="${t.grid}"/>`);
    out.push(text(x, top + rows.length * rowH + 18, v >= 1000 ? `${v / 1000} s` : `${v} ms`, { size: 12, fill: t.muted, anchor: 'middle' }));
  }
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const p50 = num(row.p50_ms), p95 = num(row.p95_ms), budget = num(row.budget_ms);
    out.push(text(32, y + 24, names[i], { size: 13, fill: t.ink, weight: 600 }));
    out.push(text(32, y + 42, `budget: ${row.budget}`, { size: 11.5, fill: t.muted }));
    out.push(`<g><title>${names[i]}: p50 ${p50} ms, p95 ${p95} ms</title>${barRight(X(50), y + 14, X(p50) - X(50), 22, AFTER[mode])}</g>`);
    out.push(`<g stroke="${t.ink2}" stroke-width="1.25"><line x1="${r(X(p50))}" x2="${r(X(p95))}" y1="${y + 25}" y2="${y + 25}"/><line x1="${r(X(p95))}" x2="${r(X(p95))}" y1="${y + 19}" y2="${y + 31}"/></g>`);
    out.push(`<line x1="${r(X(budget))}" x2="${r(X(budget))}" y1="${y + 6}" y2="${y + 44}" stroke="${ARM_COLOR[mode]['docs-only']}" stroke-width="2" stroke-dasharray="4 3"/>`);
    const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
    out.push(text(X(50), y + 54, `p50 ${fmt(p50)}, p95 ${fmt(p95)}`, { size: 11.5, fill: t.ink2 }));
  });
  out.push(footer(mode, 'Source: README "Latency" (scripts/latency.ts); paper/kit/data/latency.csv. First row: Node alone (node -e 0) took 88 ms, so the budget is 88 + 150 ms.', H));
  emit('fig-f-hook-latency', mode, W, H, svgDoc(W, H, mode, 'Hook latency, p50 and p95, against budgets', 'Non-install command 121 ms p50 and 177 ms p95 (budget 238 ms including Node start); one install warm 358 / 372 ms (budget 1 s); one install cold 2.4 / 3.7 s (budget 5 s).', out.join('\n')));
}

// ------------------------------------------------------------------ (g) architecture
function figG(mode: Mode) {
  const t = THEME[mode];
  const W = 1280, H = 680;
  const accent = AFTER[mode];
  const warm = ARM_COLOR[mode]['docs-only'];
  const out: string[] = [];
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], o: { stroke?: string; mono?: boolean } = {}) => {
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${mode === 'light' ? '#ffffff' : '#222221'}" stroke="${o.stroke ?? t.axis}" stroke-width="${o.stroke ? 1.75 : 1.25}"/>`);
    out.push(text(x + 16, y + 26, title, { size: 15, weight: 650, fill: t.ink }));
    lines.forEach((l, i) => out.push(text(x + 16 + (/^\s/.test(l) ? 14 : 0), y + 50 + i * 20, l.trim(), { size: 12.5, fill: t.ink2, font: o.mono ? MONO : SANS })));
  };
  const arrow = (d: string, label?: [number, number, string], color = t.ink2) => {
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.75" marker-end="url(#ah-${mode})"/>`);
    if (label) out.push(text(label[0], label[1], label[2], { size: 12, fill: t.ink2, anchor: 'middle' }));
  };
  out.push(`<defs><marker id="ah-${mode}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.ink2}"/></marker></defs>`);
  out.push(header(mode, 'How pinright answers', 'Two entry points (MCP tools the agent calls, a hook that runs before each command or write) feed one verdict pipeline and one docs pipeline.', W));

  box(32, 260, 200, 140, 'Coding agent', ['Claude Code, Cursor,', 'VS Code (Copilot), Codex,', 'Gemini CLI, Windsurf', '+10 MCP-only clients']);
  box(330, 110, 250, 180, 'MCP tools (stdio)', ['check-packages', 'check-package', 'check-manifest', 'find-library', 'get-docs', 'upgrade-guide'], { stroke: accent, mono: true });
  box(330, 360, 250, 160, 'Pre-install hook', ['install commands (npm, pip, uv,', 'cargo, go, ...) through bash -c,', 'eval, npm run, make, ...', 'manifest and workflow writes', 'registry settings, lockfiles'], { stroke: accent });

  box(660, 100, 340, 220, 'Verdict pipeline', ['deps.dev: versions, advisories,', '   dependency graphs, Scorecard', 'OSV: advisory details, fixes, MAL-*', 'Registries: name and version exist,', '   install scripts, provenance, publisher', 'Lookalike list (offline)', 'Safe version: same release line first,', '   3-day cooldown, ok only if both answered']);
  box(660, 360, 340, 180, 'Docs pipeline', ['Package files at the version', '   (README, docs, .d.ts; wheel API)', 'Repo at the release tag (jsDelivr)', 'llms.txt / llms-full.txt', 'Site discovery from metadata', 'Normalize, scan for injection, BM25']);

  box(1050, 170, 200, 290, 'Fenced answer', ['SECURITY NOTICE with', 'the version to pin', '', 'docs inside', '<untrusted-data', '  id source>', '', 'hook: deny / ask /', 'allow with a note', '', 'URLs through the', 'SSRF guard'], { stroke: warm });

  arrow('M232,310 C282,310 280,200 328,200', [258, 222, 'calls']);
  arrow('M232,350 C282,350 280,440 328,440', [262, 474, 'runs first']);
  arrow('M580,190 L658,190');
  arrow('M580,250 C620,250 620,440 658,440');
  arrow('M580,440 C620,440 620,270 658,270');
  arrow('M1000,210 C1025,210 1025,280 1048,280');
  arrow('M1000,450 C1025,450 1025,380 1048,380');
  arrow('M1150,462 V583 Q1150,598 1135,598 H147 Q132,598 132,583 V403', [640, 622, 'the agent reads the verdict and the docs, or gets the hook decision'], t.muted);
  out.push(footer(mode, 'Public services only: deps.dev, OSV, the package registries, jsDelivr, GitHub, and the docs site a package’s metadata names. No telemetry, no account.', H, W));
  emit('fig-g-architecture', mode, W, H, svgDoc(W, H, mode, 'pinright architecture', 'The coding agent calls MCP tools or triggers the pre-install hook. Both use the verdict pipeline (deps.dev, OSV, registries, offline lookalike list); the MCP tools also use the docs pipeline (package files at the version, repo at the release tag via jsDelivr, llms.txt, site discovery). The answer goes back fenced: a security notice, docs inside untrusted-data blocks, or a deny, ask or allow decision.', out.join('\n')));
}

// ------------------------------------------------------------------ (i) tokens per run
function figI(mode: Mode) {
  const tok = readCsv('tokens_by_model_arm.csv');
  const row = (bench: string, g: string, a: string) => tok.find((x) => x.benchmark === bench && x.model === g && x.arm === a);
  const W = 1240, H = 600;
  const t = THEME[mode];
  const ARMS = ['no-docs', 'docs-only', 'pinright'];
  const panel = (bench: string, x: number, w: number, title: string) => {
    const val = (g: string, a: string) => (row(bench, g, a) ? num(row(bench, g, a)!.ktokens_total_per_run) : undefined);
    const ci = (g: string, a: string): [number, number] | undefined => {
      const r0 = row(bench, g, a);
      return r0 ? [num(r0.ktokens_total_per_run_ci95_lo), num(r0.ktokens_total_per_run_ci95_hi)] : undefined;
    };
    const lab = (g: string, a: string) => `${val(g, a)!.toFixed(0)}k`;
    return groupedBars({ mode, x, y: 140, w, h: 400, groups: MODELS, series: ARMS, value: val, ci, label: lab, color: (a) => ARM_COLOR[mode][a], max: 200, ticks: [0, 50, 100, 150, 200], tickFmt: (v) => `${v}k`, panelTitle: title });
  };
  const saved = (bench: string) => MODELS.map((g) => `${Math.round(num(row(bench, g, 'pinright')!.tokens_saved_vs_docs_only_pct))}%`).join(', ');
  const lg = legend(32, 100, ARMS.map((a) => ({ label: ARM_SHORT[a], color: ARM_COLOR[mode][a] })), mode, W - 64);
  const body = [
    header(mode, 'Tokens per run', 'Tokens the model processed per run (input, cache reads and writes, output), with 95% cluster-bootstrap intervals (tasks resampled). Runs v7, 2026-11-02, 1.0.0 code.', W),
    lg.svg,
    panel('agents', 32, 600, 'Agent benchmark (12 tasks x 2 runs)'),
    panel('docs', 660, 548, 'Docs benchmark (8 tasks x 2 runs)'),
    `<line x1="646" x2="646" y1="150" y2="540" stroke="${t.grid}"/>`,
    footer(mode, `Source: paper/kit/data/tokens_by_model_arm.csv (bench/tokens.ts). Paired by task, pinright used fewer tokens than docs-only: ${saved('agents')} (agent benchmark) and ${saved('docs')} (docs benchmark), Sonnet, Haiku, Opus. No docs used the fewest.`, H, W),
  ].join('\n');
  emit('fig-i-tokens-per-run', mode, W, H, svgDoc(W, H, mode, 'Tokens per run by arm and model', 'Grouped bars, thousands of tokens per run. Agent benchmark: no docs 15 to 21, docs-only 56 to 94, pinright 42 to 74. Docs benchmark: no docs 17 to 23, docs-only 94 to 135, pinright 63 to 95.', body));
}

// ------------------------------------------------------------------ (h) what the agent sees
function figH(mode: Mode) {
  const msg = readFileSync(join(here, 'visuals', 'cli', 'hook-block.txt'), 'utf8').trimEnd().split('\n');
  const { svg, w, h } = terminal({
    mode, cols: 96, title: 'Claude Code, PreToolUse hook: pinright hook claude',
    prompt: 'agent runs:', command: 'npm install lodash@4.17.20',
    lines: [...msg, '', '\x1b[90m(permissionDecision: deny; the command does not run)\x1b[39m'],
    highlight: (p) => (p.startsWith('pinright blocked') ? 'block' : undefined),
    desc: 'The hook answer the agent receives for npm install lodash@4.17.20: pinright blocked this dependency change; lodash 4.17.20 has 5 known advisories; use 4.x release 4.18.1.',
  });
  emit('fig-h-what-the-agent-sees', mode, w, h, svg);
}

for (const mode of ['light', 'dark'] as Mode[]) {
  figA(mode); figB(mode); figC(mode); figD(mode); figE(mode); figF(mode); figG(mode); figH(mode); figI(mode);
}
console.log(`wrote ${written.length} files in paper/kit/figures`);
