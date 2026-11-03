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
 *   partials/chart-home-tokens-{agents,docs}.html  home: tokens per run, docs only vs pinright, with intervals
 *   partials/chart-ev-tokens-{agents,docs}.html    evidence: tokens per run, three arms per model
 *   partials/chart-ev-mcptext.html    evidence: MCP tool text per run, docs only vs pinright
 *
 * Every chart is drawn twice: in English (chart-x.html) and in Spanish (chart-x.es.html, which the
 * include plugin picks for pages under es/). The words live in LANGS below; the numbers come from
 * the CSVs in both, so the two languages cannot drift. Spanish writes a decimal comma (0,3), the
 * percent sign with no space (40%) and "16 de 16" (see "Spanish" in site/README.md).
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

const MODELS = ['Sonnet 5.5', 'Opus 5.5', 'Haiku 5.5'];
const KEY_ARMS = new Set(['pinright', 'hook-only', 'pinright+hook']);

/** Words and number format per language. Model names, tool names and units stay as they are. */
const LANGS = {
  en: {
    suffix: '',
    dec: (s) => s,
    arm: { 'no-docs': 'No docs', 'docs-only': 'Docs only', pinright: 'pinright MCP', 'hook-only': 'Hook only', 'pinright+hook': 'MCP + hook', latest: 'No pin' },
    source: {},
    alertsTip: (m, a, v, lo, hi, n) => `${m}, ${a}: ${v} whole-tree alerts per project (95% interval ${lo} to ${hi}, ${n} projects)`,
    pinsTip: (m, a, k, n, p, lo, hi) => `${m}, ${a}: ${k} of ${n} direct dependencies with a known advisory (${p}%, 95% interval ${lo}% to ${hi}%)`,
    docsText: (v, n) => `${v} of ${n}`,
    docsTip: (m, a, v, n) => `${m}, ${a}: ${v} of ${n} runs wrote the current API`,
    tokensWhat: { tokens: 'tokens per run', text: 'characters of MCP tool text per run' },
    where: { agents: 'agent tasks', docs: 'docs tasks' },
    tokensTip: (m, a, where, v, what, lo, hi, n, saved) =>
      `${m}, ${a}, ${where}: ${v} ${what} (95% interval ${lo} to ${hi}, ${n} runs)${saved != null ? `; ${saved}% less than docs only on the same tasks` : ''}`,
    fpBefore: 'Before fixes',
    fpAfter: 'After fixes',
    fpTip: (src, p, when, n) => `${src}: ${p}% blocked or asked ${when} the fixes (${n} entries)`,
    fpWhen: { before: 'before', after: 'after' },
    t: {
      homeAlerts: 'Whole-tree alerts per project',
      homeAlertsDesc: 'Mean npm audit and pip-audit alerts per generated project, by model: no docs, docs only (pinright with its verdict off), and the pinright MCP server plus hook. ',
      homePins: 'Direct dependencies pinned with a known advisory',
      homePinsDesc: 'Share of direct dependencies the agent pinned with at least one deps.dev advisory, by model. ',
      homeDocs: 'Docs tasks that used the current API',
      homeDocsDesc: 'Docs benchmark runs, out of 16 per model, that installed, built, passed a smoke test and used the current API. ',
      tokensAgents: 'Tokens per run, agent tasks',
      tokensDocs: 'Tokens per run, docs tasks',
      homeTokensAgentsDesc: 'Mean tokens the model processed per run on the 12 agent tasks, docs only (pinright with its security layer off) against the pinright MCP server, with 95% intervals. ',
      homeTokensDocsDesc: 'Mean tokens the model processed per run on the 8 docs tasks, docs only against the pinright MCP server, with 95% intervals. ',
      evAlerts: 'Whole-tree alerts per project',
      evAlertsDesc: 'Mean whole-tree alerts per project for every arm with 95% intervals. ',
      evPins: 'Direct dependencies with a known advisory',
      evPinsDesc: 'Share of pinned direct dependencies with a known advisory for every arm with 95% intervals. ',
      evDocs: 'Docs runs that wrote the current API',
      evDocsDesc: 'Docs benchmark runs out of 16 that wrote the current API, with 95% intervals. ',
      evTokensAgentsDesc: 'Mean tokens per run on the 12 agent tasks for no docs, docs only and the pinright MCP server, with 95% intervals. ',
      evTokensDocsDesc: 'Mean tokens per run on the 8 docs tasks for no docs, docs only and the pinright MCP server, with 95% intervals. ',
      evText: 'MCP tool text per run, agent tasks',
      evTextDesc: 'Thousands of characters the MCP tools returned per run on the 12 agent tasks, docs only against the pinright MCP server, with 95% intervals. ',
      fp: 'Hook blocked or asked, by source',
      fpDesc: 'Share of public commands and manifest writes the hook blocked or asked about, before and after the fixes this replay prompted, by source. ',
    },
  },
  es: {
    suffix: '.es',
    dec: (s) => s.replace('.', ','),
    arm: { 'no-docs': 'Sin docs', 'docs-only': 'Solo docs', pinright: 'pinright MCP', 'hook-only': 'Solo hook', 'pinright+hook': 'MCP + hook', latest: 'Sin versión' },
    source: {
      'package.json scripts': 'Scripts de package.json',
      'README / CONTRIBUTING lines': 'Líneas de README / CONTRIBUTING',
      'Makefile / justfile targets': 'Objetivos de Makefile / justfile',
      'GitHub Actions run: steps': 'Pasos run: de GitHub Actions',
      'Dockerfile RUN': 'RUN de Dockerfile',
      'Manifest writes': 'Escrituras de manifiestos',
    },
    alertsTip: (m, a, v, lo, hi, n) => `${m}, ${a}: ${v} alertas en todo el árbol por proyecto (intervalo del 95%: ${lo} a ${hi}, ${n} proyectos)`,
    pinsTip: (m, a, k, n, p, lo, hi) => `${m}, ${a}: ${k} de ${n} dependencias directas con un aviso de seguridad conocido (${p}%, intervalo del 95%: ${lo}% a ${hi}%)`,
    docsText: (v, n) => `${v} de ${n}`,
    docsTip: (m, a, v, n) => `${m}, ${a}: ${v} de ${n} ejecuciones escribieron la API actual`,
    tokensWhat: { tokens: 'tokens por ejecución', text: 'caracteres de texto de herramientas MCP por ejecución' },
    where: { agents: 'tareas de agente', docs: 'tareas de docs' },
    tokensTip: (m, a, where, v, what, lo, hi, n, saved) =>
      `${m}, ${a}, ${where}: ${v} ${what} (intervalo del 95%: ${lo} a ${hi}, ${n} ejecuciones)${saved != null ? `; ${saved}% menos que solo docs en las mismas tareas` : ''}`,
    fpBefore: 'Sin arreglos',
    fpAfter: 'Con arreglos',
    fpTip: (src, p, when, n) => `${src}: ${p}% bloqueado o con pregunta ${when} los arreglos (${n} entradas)`,
    fpWhen: { before: 'antes de', after: 'después de' },
    t: {
      homeAlerts: 'Alertas en todo el árbol por proyecto',
      homeAlertsDesc: 'Promedio de alertas de npm audit y pip-audit por proyecto generado, por modelo: sin docs, solo docs (pinright con su veredicto apagado) y el servidor MCP de pinright con el hook. ',
      homePins: 'Dependencias directas fijadas con un aviso de seguridad conocido',
      homePinsDesc: 'Proporción de dependencias directas que el agente fijó con al menos un aviso de seguridad de deps.dev, por modelo. ',
      homeDocs: 'Tareas de docs que usaron la API actual',
      homeDocsDesc: 'Ejecuciones del benchmark de docs, de 16 por modelo, que instalaron, compilaron, pasaron una prueba de humo y usaron la API actual. ',
      tokensAgents: 'Tokens por ejecución, tareas de agente',
      tokensDocs: 'Tokens por ejecución, tareas de docs',
      homeTokensAgentsDesc: 'Promedio de tokens que el modelo procesó por ejecución en las 12 tareas de agente, solo docs (pinright con su capa de seguridad apagada) contra el servidor MCP de pinright, con intervalos del 95%. ',
      homeTokensDocsDesc: 'Promedio de tokens que el modelo procesó por ejecución en las 8 tareas de docs, solo docs contra el servidor MCP de pinright, con intervalos del 95%. ',
      evAlerts: 'Alertas en todo el árbol por proyecto',
      evAlertsDesc: 'Promedio de alertas en todo el árbol por proyecto para cada brazo, con intervalos del 95%. ',
      evPins: 'Dependencias directas con un aviso de seguridad conocido',
      evPinsDesc: 'Proporción de dependencias directas fijadas con un aviso de seguridad conocido para cada brazo, con intervalos del 95%. ',
      evDocs: 'Ejecuciones de docs que escribieron la API actual',
      evDocsDesc: 'Ejecuciones del benchmark de docs, de 16, que escribieron la API actual, con intervalos del 95%. ',
      evTokensAgentsDesc: 'Promedio de tokens por ejecución en las 12 tareas de agente para sin docs, solo docs y el servidor MCP de pinright, con intervalos del 95%. ',
      evTokensDocsDesc: 'Promedio de tokens por ejecución en las 8 tareas de docs para sin docs, solo docs y el servidor MCP de pinright, con intervalos del 95%. ',
      evText: 'Texto de herramientas MCP por ejecución, tareas de agente',
      evTextDesc: 'Miles de caracteres que devolvieron las herramientas MCP por ejecución en las 12 tareas de agente, solo docs contra el servidor MCP de pinright, con intervalos del 95%. ',
      fp: 'El hook bloqueó o preguntó, por fuente',
      fpDesc: 'Proporción de comandos públicos y escrituras de manifiestos que el hook bloqueó o sobre los que preguntó, antes y después de los arreglos que motivó esta repetición, por fuente. ',
    },
  },
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
const tokens = readCsv('tokens_by_model_arm.csv');
const fpSources = readCsv('fp_by_source.csv').filter((r) => !r.source.startsWith('All sources'));
const pick = (rows, model, arm) => rows.find((r) => r.model === model && r.arm === arm);

const maxOf = (rows, whiskers) => Math.max(...rows.map((r) => (whiskers && r.hi != null ? r.hi : r.value)));
const niceMax = (m) => { const step = m > 20 ? 10 : m > 5 ? 2 : 1; return Math.ceil(m / step) * step; };
const tickSet = (max, step, fmt) => Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => ({ v: i * step, label: fmt(i * step) }));

/** Every chart partial in one language: { 'chart-home-alerts.html': '<svg…>', … }. */
function chartsFor(L) {
  const r1 = (n) => L.dec((Math.round(n * 10) / 10).toFixed(1));
  const k1 = (n) => `${r1(n)}k`;
  const armOf = (arm) => ({ label: L.arm[arm], key: KEY_ARMS.has(arm) });

  function agentRows(arms, metric) {
    const rows = [];
    for (const model of MODELS) {
      for (const arm of arms) {
        const r = pick(agents, model, arm);
        if (!r) continue;
        const A = armOf(arm);
        if (metric === 'alerts') {
          const v = num(r.alerts_per_project_mean);
          const lo = num(r.alerts_per_project_ci95_lo);
          const hi = num(r.alerts_per_project_ci95_hi);
          rows.push({ group: model, label: A.label, value: v, lo, hi, text: r1(v), key: A.key,
            tip: L.alertsTip(model, A.label, r1(v), r1(lo), r1(hi), r.projects_resolved) });
        } else {
          const v = num(r.direct_deps_with_advisory_pct);
          const lo = num(r.direct_deps_with_advisory_pct_ci95_lo);
          const hi = num(r.direct_deps_with_advisory_pct_ci95_hi);
          rows.push({ group: model, label: A.label, value: v, lo, hi, text: `${Math.round(v)}%`, key: A.key,
            tip: L.pinsTip(model, A.label, r.direct_deps_with_advisory, r.direct_deps, Math.round(v), Math.round(lo), Math.round(hi)) });
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
        const A = armOf(arm);
        const v = num(r.current_api_runs);
        const n = num(r.runs);
        rows.push({ group: model, label: A.label, value: v, lo: (num(r.current_api_pct_ci95_lo) / 100) * n, hi: (num(r.current_api_pct_ci95_hi) / 100) * n,
          text: L.docsText(v, n), key: A.key, tip: L.docsTip(model, A.label, v, n) });
      }
    }
    return rows;
  }

  /** Tokens per run (metric 'tokens') or MCP tool text per run ('text'), in thousands, from tokens_by_model_arm.csv. */
  function tokenRows(benchmark, arms, metric) {
    const col = metric === 'tokens' ? 'ktokens_total_per_run' : 'mcp_result_kchars_per_run';
    const rows = [];
    for (const model of MODELS) {
      for (const arm of arms) {
        const r = tokens.find((x) => x.benchmark === benchmark && x.model === model && x.arm === arm);
        if (!r) continue;
        const A = armOf(arm);
        const v = num(r[col]);
        const lo = num(r[`${col}_ci95_lo`]);
        const hi = num(r[`${col}_ci95_hi`]);
        const saved = metric === 'tokens' ? num(r.tokens_saved_vs_docs_only_pct) : num(r.mcp_text_saved_vs_docs_only_pct);
        rows.push({ group: model, label: A.label, value: v, lo, hi, text: k1(v), key: A.key,
          tip: L.tokensTip(model, A.label, L.where[benchmark], k1(v), L.tokensWhat[metric], k1(lo), k1(hi), r.runs, saved != null ? Math.round(saved) : null) });
      }
    }
    return rows;
  }

  /** One panel per model, all on the same scale, for the evidence page. */
  function perModel(rowsAll, { title, desc, max, ticks, width = 340 }) {
    return MODELS.map((model) => {
      const rows = rowsAll.filter((r) => r.group === model).map((r) => ({ ...r, group: model }));
      return `<div class="chart-panel">${bars({ title: `${title}, ${model}`, desc, rows, max, width, labelW: 96, valueW: 46, whiskers: true, ticks })}</div>`;
    }).join('\n');
  }

  const T = L.t;
  const tips = (rows) => rows.map((r) => r.tip).join('. ');
  const files = {};

  // Home: the three arms a reader needs, no intervals (the evidence page has them).
  const homeArms = ['no-docs', 'docs-only', 'pinright+hook'];
  {
    const rows = agentRows(homeArms, 'alerts');
    files['chart-home-alerts.html'] = bars({ title: T.homeAlerts, rows, max: maxOf(rows), desc: T.homeAlertsDesc + tips(rows) });
  }
  {
    const rows = agentRows(homeArms, 'pins');
    files['chart-home-pins.html'] = bars({ title: T.homePins, rows, max: maxOf(rows), desc: T.homePinsDesc + tips(rows) });
  }
  {
    const rows = docsRows(['no-docs', 'pinright']);
    files['chart-home-docs.html'] = bars({ title: T.homeDocs, rows, max: 16, desc: T.homeDocsDesc + tips(rows) });
  }

  // Home, efficiency: docs only against pinright, tokens per run with intervals, one chart per benchmark on one scale.
  {
    const agentsRows = tokenRows('agents', ['docs-only', 'pinright'], 'tokens');
    const docsRowsT = tokenRows('docs', ['docs-only', 'pinright'], 'tokens');
    const max = niceMax(Math.max(maxOf(agentsRows, true), maxOf(docsRowsT, true)));
    const ticks = tickSet(max, 50, (v) => (v ? `${v}k` : '0'));
    files['chart-home-tokens-agents.html'] = bars({ title: T.tokensAgents, rows: agentsRows, max, width: 420, whiskers: true, ticks,
      desc: T.homeTokensAgentsDesc + tips(agentsRows) });
    files['chart-home-tokens-docs.html'] = bars({ title: T.tokensDocs, rows: docsRowsT, max, width: 420, whiskers: true, ticks,
      desc: T.homeTokensDocsDesc + tips(docsRowsT) });
  }

  // Evidence: every arm, with 95% cluster-bootstrap intervals, one panel per model on a shared scale.
  const allArms = ['no-docs', 'docs-only', 'pinright', 'hook-only', 'pinright+hook', 'latest'];
  {
    const rows = agentRows(allArms, 'alerts');
    const max = niceMax(maxOf(rows, true));
    files['chart-ev-alerts.html'] = perModel(rows, { title: T.evAlerts, max, ticks: tickSet(max, 10, String), desc: T.evAlertsDesc + tips(rows) });
  }
  {
    const rows = agentRows(allArms, 'pins');
    const max = niceMax(maxOf(rows, true));
    files['chart-ev-pins.html'] = perModel(rows, { title: T.evPins, max, ticks: tickSet(max, 20, (v) => `${v}%`), desc: T.evPinsDesc + tips(rows) });
  }
  {
    const rows = docsRows(['no-docs', 'docs-only', 'pinright']);
    files['chart-ev-docs.html'] = perModel(rows, { title: T.evDocs, max: 16, ticks: tickSet(16, 4, String), desc: T.evDocsDesc + tips(rows) });
  }
  {
    const effArms = ['no-docs', 'docs-only', 'pinright'];
    const a = tokenRows('agents', effArms, 'tokens');
    const d = tokenRows('docs', effArms, 'tokens');
    const max = niceMax(Math.max(maxOf(a, true), maxOf(d, true)));
    const ticks = tickSet(max, 50, (v) => (v ? `${v}k` : '0'));
    files['chart-ev-tokens-agents.html'] = perModel(a, { title: T.tokensAgents, max, ticks, desc: T.evTokensAgentsDesc + tips(a) });
    files['chart-ev-tokens-docs.html'] = perModel(d, { title: T.tokensDocs, max, ticks, desc: T.evTokensDocsDesc + tips(d) });
    const t = tokenRows('agents', ['docs-only', 'pinright'], 'text');
    const tmax = niceMax(maxOf(t, true));
    files['chart-ev-mcptext.html'] = perModel(t, { title: T.evText, max: tmax, ticks: tickSet(tmax, 20, (v) => (v ? `${v}k` : '0')), desc: T.evTextDesc + tips(t) });
  }
  {
    const rows = [];
    const p2 = (n) => L.dec(n.toFixed(2));
    for (const r of fpSources) {
      const src = L.source[r.source] ?? r.source;
      const before = num(r.blocked_or_asked_pct_baseline);
      const after = num(r.blocked_or_asked_pct_after_fixes);
      rows.push({ group: src, label: L.fpBefore, value: before, text: `${p2(before)}%`, key: false, tip: L.fpTip(src, p2(before), L.fpWhen.before, r.entries) });
      rows.push({ group: src, label: L.fpAfter, value: after, text: `${p2(after)}%`, key: true, tip: L.fpTip(src, p2(after), L.fpWhen.after, r.entries) });
    }
    files['chart-ev-fp.html'] = bars({ title: T.fp, rows, max: 8, width: 560, labelW: 112, valueW: 60, ticks: tickSet(8, 2, (v) => `${v}%`), desc: T.fpDesc + tips(rows) });
  }
  return files;
}

let count = 0;
for (const L of Object.values(LANGS)) {
  for (const [name, svg] of Object.entries(chartsFor(L))) {
    fs.writeFileSync(path.join(partials, name.replace(/\.html$/, `${L.suffix}.html`)), `${svg}\n`);
    count++;
  }
}
console.log(`charts: ${count} chart partials written to partials/ (English and Spanish)`);
