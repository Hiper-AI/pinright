/**
 * Draws the benchmark charts as inline SVG partials, from the same CSVs as the report figures
 * (paper/kit/data). Colors come from CSS classes, so the charts follow the light and dark theme
 * without a second file, and the CSP needs no inline style: everything here is SVG attributes.
 *
 *   partials/chart-home-alerts.html   home: whole-tree alerts per project, three arms per model
 *   partials/chart-home-pins.html     home: direct dependencies with a known advisory
 *   partials/chart-home-docs.html     home: docs runs that wrote the current API
 *   partials/chart-ev-alerts.html     evidence: every arm, per model, with 95% intervals
 *   partials/chart-ev-pins.html       evidence: same for direct dependencies
 *   partials/chart-ev-docs.html       evidence: docs benchmark with intervals
 *   partials/chart-ev-fp.html         evidence: hook false-positive rate by source
 *
 * Each bar carries a <title> (the browser tooltip) and every chart a text alternative; the tables
 * on the same pages hold the numbers too. The files are generated, so they are gitignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(site, '..', 'paper', 'kit', 'data');
const partials = path.join(site, 'partials');

/** RFC 4180 enough for these files: quoted fields may hold commas. */
function readCsv(name) {
  const text = fs.readFileSync(path.join(data, name), 'utf8').trim();
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (s) => (s === '' || s == null ? null : Number(s));
const r1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

const MODELS = ['Sonnet 5.5', 'Opus 5.5', 'Haiku 5.5'];
const ARM = {
  'no-docs': { label: 'No docs', key: false },
  'docs-only': { label: 'Docs only', key: false },
  pinright: { label: 'pinright MCP', key: true },
  'hook-only': { label: 'Hook only', key: true },
  'pinright+hook': { label: 'MCP + hook', key: true },
  latest: { label: 'No pin', key: false },
};

let uid = 0;

/**
 * Horizontal bars, one labeled row per bar, grouped under a heading. rows: { group, label, value,
 * lo?, hi?, text, tip, key }. Bars start at zero; a zero value draws a 2px tick so the row still
 * reads as measured, not missing.
 */
function bars({ title, desc, rows, max, width = 340, labelW = 92, valueW = 60, whiskers = false, ticks = [] }) {
  const id = `ch${++uid}`;
  const rowH = 24;
  const groupH = 26;
  const top = 4;
  const x0 = labelW;
  const bw = width - labelW - valueW;
  const sx = (v) => x0 + (Math.max(0, v) / max) * bw;
  let y = top;
  let lastGroup = null;
  const out = [];
  for (const r of rows) {
    if (r.group && r.group !== lastGroup) {
      if (lastGroup !== null) y += 6;
      out.push(`<text class="c-group" x="0" y="${y + 16}">${esc(r.group)}</text>`);
      y += groupH;
      lastGroup = r.group;
    }
    const cy = y + rowH / 2;
    const w = Math.max(2, sx(r.value) - x0);
    const cls = r.key ? 'c-bar c-key' : 'c-bar';
    out.push(`<g class="c-row"><title>${esc(r.tip)}</title>`);
    out.push(`<rect class="c-hit" x="0" y="${y}" width="${width}" height="${rowH}"/>`);
    out.push(`<text class="c-label" x="0" y="${cy + 4}">${esc(r.label)}</text>`);
    out.push(`<rect class="${cls}" x="${x0}" y="${cy - 6}" width="${w.toFixed(1)}" height="12" rx="2"/>`);
    let end = x0 + w;
    if (whiskers && r.lo != null && r.hi != null && r.hi > r.lo) {
      const a = sx(r.lo);
      const b = sx(r.hi);
      out.push(`<path class="c-ci" d="M${a.toFixed(1)} ${cy}H${b.toFixed(1)}M${a.toFixed(1)} ${cy - 3}v6M${b.toFixed(1)} ${cy - 3}v6"/>`);
      end = Math.max(end, b);
    }
    out.push(`<text class="c-value${r.key ? ' c-value-key' : ''}" x="${(end + 6).toFixed(1)}" y="${cy + 4}">${esc(r.text)}</text>`);
    out.push('</g>');
    y += rowH;
  }
  const h = y + 22;
  const axis = [`<path class="c-axis" d="M${x0} ${top}V${y}"/>`];
  for (const t of ticks) {
    const x = sx(t.v);
    axis.push(`<path class="c-grid" d="M${x.toFixed(1)} ${top}V${y}"/>`);
    axis.push(`<text class="c-tick" x="${x.toFixed(1)}" y="${y + 15}" text-anchor="middle">${esc(t.label)}</text>`);
  }
  return `<svg class="chart" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-labelledby="${id}-t ${id}-d" focusable="false"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>${axis.join('')}${out.join('')}</svg>`;
}

const agents = readCsv('agents_by_model_arm.csv');
const docs = readCsv('docs_by_model_arm.csv');
const pick = (rows, model, arm) => rows.find((r) => r.model === model && r.arm === arm);

function agentRows(arms, metric) {
  const rows = [];
  for (const model of MODELS) {
    for (const arm of arms) {
      const r = pick(agents, model, arm);
      if (!r) continue;
      if (metric === 'alerts') {
        const v = num(r.alerts_per_project_mean);
        const lo = num(r.alerts_per_project_ci95_lo);
        const hi = num(r.alerts_per_project_ci95_hi);
        rows.push({ group: model, label: ARM[arm].label, value: v, lo, hi, text: r1(v), key: ARM[arm].key,
          tip: `${model}, ${ARM[arm].label}: ${r1(v)} whole-tree alerts per project (95% interval ${r1(lo)} to ${r1(hi)}, ${r.runs} runs)` });
      } else {
        const v = num(r.direct_deps_with_advisory_pct);
        const lo = num(r.direct_deps_with_advisory_pct_ci95_lo);
        const hi = num(r.direct_deps_with_advisory_pct_ci95_hi);
        rows.push({ group: model, label: ARM[arm].label, value: v, lo, hi, text: `${Math.round(v)}%`, key: ARM[arm].key,
          tip: `${model}, ${ARM[arm].label}: ${r.direct_deps_with_advisory} of ${r.direct_deps} direct dependencies with a known advisory (${Math.round(v)}%, 95% interval ${Math.round(lo)}% to ${Math.round(hi)}%)` });
      }
    }
  }
  return rows;
}

function docsRows(arms) {
  const rows = [];
  for (const model of MODELS) {
    for (const arm of arms) {
      const r = pick(docs, model, arm);
      if (!r) continue;
      const v = num(r.current_api_runs);
      const n = num(r.runs);
      rows.push({ group: model, label: ARM[arm].label, value: v, lo: (num(r.current_api_pct_ci95_lo) / 100) * n, hi: (num(r.current_api_pct_ci95_hi) / 100) * n,
        text: `${v} of ${n}`, key: ARM[arm].key, tip: `${model}, ${ARM[arm].label}: ${v} of ${n} runs wrote the current API` });
    }
  }
  return rows;
}

const maxOf = (rows, whiskers) => Math.max(...rows.map((r) => (whiskers && r.hi != null ? r.hi : r.value)));
const niceMax = (m) => { const step = m > 20 ? 10 : m > 5 ? 2 : 1; return Math.ceil(m / step) * step; };
const tickSet = (max, step, fmt) => Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => ({ v: i * step, label: fmt(i * step) }));

/** One panel per model, all on the same scale, for the evidence page. */
function perModel(rowsAll, { title, desc, max, ticks, width = 340 }) {
  return MODELS.map((model) => {
    const rows = rowsAll.filter((r) => r.group === model).map((r) => ({ ...r, group: model }));
    return `<div class="chart-panel">${bars({ title: `${title}, ${model}`, desc, rows, max, width, labelW: 96, valueW: 46, whiskers: true, ticks })}</div>`;
  }).join('\n');
}

const files = {};

// Home: the three arms a reader needs, no intervals (the evidence page has them).
const homeArms = ['no-docs', 'docs-only', 'pinright+hook'];
{
  const rows = agentRows(homeArms, 'alerts');
  files['chart-home-alerts.html'] = bars({ title: 'Whole-tree alerts per project', rows, max: maxOf(rows),
    desc: 'Mean npm audit and pip-audit alerts per generated project, by model: no docs, docs only (pinright with its verdict off), and the pinright MCP server plus hook. ' + rows.map((r) => r.tip).join('. ') });
}
{
  const rows = agentRows(homeArms, 'pins');
  files['chart-home-pins.html'] = bars({ title: 'Direct dependencies pinned with a known advisory', rows, max: maxOf(rows),
    desc: 'Share of direct dependencies the agent pinned with at least one deps.dev advisory, by model. ' + rows.map((r) => r.tip).join('. ') });
}
{
  const rows = docsRows(['no-docs', 'pinright']);
  files['chart-home-docs.html'] = bars({ title: 'Docs tasks that used the current API', rows, max: 16,
    desc: 'Docs benchmark runs, out of 16 per model, that installed, built, passed a smoke test and used the current API. ' + rows.map((r) => r.tip).join('. ') });
}

// Evidence: every arm, with 95% cluster-bootstrap intervals, one panel per model on a shared scale.
const allArms = ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest'];
{
  const rows = agentRows(allArms, 'alerts');
  const max = niceMax(maxOf(rows, true));
  files['chart-ev-alerts.html'] = perModel(rows, { title: 'Whole-tree alerts per project', max, ticks: tickSet(max, 10, String),
    desc: 'Mean whole-tree alerts per project for every arm with 95% intervals. ' + rows.map((r) => r.tip).join('. ') });
}
{
  const rows = agentRows(allArms, 'pins');
  const max = niceMax(maxOf(rows, true));
  files['chart-ev-pins.html'] = perModel(rows, { title: 'Direct dependencies with a known advisory', max, ticks: tickSet(max, 20, (v) => `${v}%`),
    desc: 'Share of pinned direct dependencies with a known advisory for every arm with 95% intervals. ' + rows.map((r) => r.tip).join('. ') });
}
{
  const rows = docsRows(['no-docs', 'docs-only', 'pinright']);
  files['chart-ev-docs.html'] = perModel(rows, { title: 'Docs runs that wrote the current API', max: 16, ticks: tickSet(16, 4, String),
    desc: 'Docs benchmark runs out of 16 that wrote the current API, with 95% intervals. Docs only ran for Sonnet. ' + rows.map((r) => r.tip).join('. ') });
}
{
  const fp = readCsv('fp_by_source.csv').filter((r) => !r.source.startsWith('All sources'));
  const rows = [];
  for (const r of fp) {
    const before = num(r.blocked_or_asked_pct_baseline);
    const after = num(r.blocked_or_asked_pct_after_fixes);
    rows.push({ group: r.source, label: 'Before fixes', value: before, text: `${before.toFixed(2)}%`, key: false, tip: `${r.source}: ${before.toFixed(2)}% blocked or asked before the fixes (${r.entries} entries)` });
    rows.push({ group: r.source, label: 'After fixes', value: after, text: `${after.toFixed(2)}%`, key: true, tip: `${r.source}: ${after.toFixed(2)}% blocked or asked after the fixes (${r.entries} entries)` });
  }
  files['chart-ev-fp.html'] = bars({ title: 'Hook blocked or asked, by source', rows, max: 8, width: 560, labelW: 112, valueW: 60, ticks: tickSet(8, 2, (v) => `${v}%`),
    desc: 'Share of public commands and manifest writes the hook blocked or asked about, before and after the fixes this replay prompted, by source. ' + rows.map((r) => r.tip).join('. ') });
}

for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(partials, name), `${svg}\n`);
console.log(`charts: ${Object.keys(files).length} chart partials written to partials/`);
