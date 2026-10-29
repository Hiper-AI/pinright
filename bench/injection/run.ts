/**
 * Prompt-injection detector against real documentation: what share of the
 * docs safectx serves for popular npm and PyPI packages would it drop (high)
 * or flag (medium)? Every chunk of every document query-docs gathers is
 * scanned, not only the few a query returns, plus the upgrade-guide output for
 * a few big upgrades. Also prints the adversarial-corpus numbers.
 *
 * Hits the real registries and GitHub (set GITHUB_TOKEN). Context7 is off so the
 * numbers are about safectx's own sources.
 *
 * Run: npx tsx bench/injection/run.ts   (results go to bench/injection/RESULTS.md)
 */
import fs from 'node:fs';
import path from 'node:path';
import { collectDocs, getDocs } from '../../src/docs/index.js';
import { chunkFile } from '../../src/docs/retrieve.js';
import { type Ecosystem } from '../../src/ecosystems.js';
import { upgradeGuide } from '../../src/upgrade/index.js';
import { prepare, scanText } from '../../src/untrusted/index.js';
import { checkPackage } from '../../src/verdict.js';
import { corpusNumbers } from './corpus.js';

process.env.SAFECTX_CONTEXT7 = 'off';

const LIBS: [Ecosystem, string, string][] = [
  ['npm', 'next', 'protect routes with middleware'],
  ['npm', 'react', 'useEffect cleanup'],
  ['npm', 'express', 'error handling middleware'],
  ['npm', 'zod', 'parse and refine objects'],
  ['npm', 'axios', 'interceptors and retries'],
  ['npm', 'lodash', 'debounce'],
  ['npm', 'vite', 'environment variables config'],
  ['npm', 'prisma', 'migrate and seed'],
  ['npm', '@anthropic-ai/sdk', 'tool use streaming'],
  ['npm', 'openai', 'chat completions with tools'],
  ['npm', 'ai', 'generateText with tools'],
  ['npm', 'langchain', 'agents with tools'],
  ['npm', '@modelcontextprotocol/sdk', 'register a tool on a server'],
  ['npm', 'jsonwebtoken', 'verify a token'],
  ['npm', 'dotenv', 'load environment variables'],
  ['npm', 'mongoose', 'schema validation'],
  ['npm', 'fastify', 'plugins and hooks'],
  ['npm', 'stripe', 'webhook signature'],
  ['pypi', 'requests', 'retries and timeouts'],
  ['pypi', 'fastapi', 'dependencies and security'],
  ['pypi', 'pydantic', 'validators'],
  ['pypi', 'django', 'middleware'],
  ['pypi', 'flask', 'blueprints'],
  ['pypi', 'httpx', 'async client'],
  ['pypi', 'anthropic', 'tool use'],
  ['pypi', 'openai', 'function calling'],
  ['pypi', 'langchain', 'agents and tools'],
  ['pypi', 'transformers', 'chat templates'],
  ['pypi', 'sqlalchemy', 'session and engine'],
  ['pypi', 'boto3', 'presigned urls'],
  ['pypi', 'pandas', 'merge dataframes'],
  ['pypi', 'pytest', 'fixtures'],
];

const UPGRADES: [Ecosystem, string, string][] = [
  ['npm', 'next', '14.2.0'],
  ['npm', 'zod', '3.23.0'],
  ['npm', 'express', '4.21.0'],
  ['pypi', 'pydantic', '1.10.0'],
  ['pypi', 'langchain', '0.2.0'],
  ['npm', 'openai', '4.50.0'],
];

interface Flag {
  pkg: string;
  source: string;
  level: string;
  reasons: string[];
  excerpt: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 180);

async function docsFor(eco: Ecosystem, name: string, query: string) {
  const v = await checkPackage(eco, name, undefined, { risk: false });
  const version = v.report.safeVersion ?? v.report.latestVersion;
  if (!version) throw new Error('no version');
  const { docFiles } = await collectDocs({ ecosystem: eco, name, version, query });
  const flags: Flag[] = [];
  let chunks = 0;
  let bytes = 0;
  for (const d of docFiles) {
    const p = prepare(d.content, d.kind === 'types' ? 'code' : 'markdown');
    if (p.hiddenScan.level !== 'none') {
      flags.push({ pkg: `${name}@${version}`, source: `${d.label} (hidden text)`, level: p.hiddenScan.level, reasons: p.hiddenScan.reasons, excerpt: oneLine(p.hidden.map((h) => h.text).join(' / ')) });
    }
    for (const c of chunkFile({ ...d, content: p.text })) {
      chunks++;
      bytes += c.text.length;
      const s = scanText(c.text);
      if (s.level !== 'none') flags.push({ pkg: `${name}@${version}`, source: d.label, level: s.level, reasons: s.reasons, excerpt: oneLine(c.text) });
    }
  }
  // The answer itself, end to end: did query-docs remove or warn about anything?
  const served = await getDocs({ ecosystem: eco, name, version, query });
  const removed = (served.text.match(/^safectx: removed/gm) ?? []).length;
  const warned = (served.text.match(/^safectx: the next block/gm) ?? []).length;
  return { version, files: docFiles.length, chunks, bytes, flags, removed, warned };
}

async function main() {
  const rows: string[] = [];
  const flags: Flag[] = [];
  let chunks = 0;
  let bytes = 0;
  let served = 0;
  let servedRemoved = 0;
  let servedWarned = 0;
  // Four at a time: each package fetches dozens of files.
  const results = new Map<string, Awaited<ReturnType<typeof docsFor>> | Error>();
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < LIBS.length) {
      const [eco, name, query] = LIBS[next++];
      const t0 = Date.now();
      const r = await docsFor(eco, name, query).catch((err: Error) => err);
      results.set(`${eco}:${name}`, r);
      console.log(`${eco}:${name} done in ${Math.round((Date.now() - t0) / 1000)}s${r instanceof Error ? `: ${r.message}` : ''}`);
    }
  }));
  for (const [eco, name] of LIBS) {
    try {
      const r = results.get(`${eco}:${name}`);
      if (!r || r instanceof Error) throw r ?? new Error('not run');
      chunks += r.chunks;
      bytes += r.bytes;
      flags.push(...r.flags);
      served++;
      servedRemoved += r.removed;
      servedWarned += r.warned;
      const high = r.flags.filter((f) => f.level === 'high').length;
      const med = r.flags.filter((f) => f.level === 'medium').length;
      rows.push(`| ${eco}:${name}@${r.version} | ${r.files} | ${r.chunks} | ${high} | ${med} | ${r.removed}/${r.warned} |`);
      console.log(`${eco}:${name}@${r.version}: ${r.files} files, ${r.chunks} chunks, ${high} high, ${med} medium`);
    } catch (err) {
      rows.push(`| ${eco}:${name} | error: ${oneLine((err as Error).message)} | | | | |`);
      console.log(`${eco}:${name}: ${(err as Error).message}`);
    }
  }

  const upRows: string[] = [];
  let upRemoved = 0;
  let upWarned = 0;
  for (const [eco, name, from] of UPGRADES) {
    try {
      const r = await upgradeGuide({ ecosystem: eco, name, from });
      const removed = (r.text.match(/^safectx: removed/gm) ?? []).length;
      const warned = (r.text.match(/^safectx: the next block/gm) ?? []).length;
      upRemoved += removed;
      upWarned += warned;
      upRows.push(`| ${eco}:${name} ${r.from} -> ${r.to} | ${r.text.length} | ${removed} | ${warned} |`);
      console.log(`upgrade ${name} ${r.from} -> ${r.to}: ${removed} removed, ${warned} warned`);
    } catch (err) {
      upRows.push(`| ${eco}:${name} ${from} | error: ${oneLine((err as Error).message)} | | |`);
    }
  }

  const high = flags.filter((f) => f.level === 'high');
  const med = flags.filter((f) => f.level === 'medium');
  const pct = (n: number) => `${((100 * n) / Math.max(1, chunks)).toFixed(2)}%`;
  const c = corpusNumbers();
  const md = [
    '# Prompt-injection detector: measured',
    '',
    `Run on ${new Date().toISOString().slice(0, 10)} with \`npx tsx bench/injection/run.ts\` (live registries and GitHub, Context7 off).`,
    '',
    '## False positives on real documentation',
    '',
    `${served} packages (${LIBS.filter((l) => l[0] === 'npm').length} npm, ${LIBS.filter((l) => l[0] === 'pypi').length} PyPI). Every chunk of every document query-docs gathered for them was scanned: ` +
      `**${chunks} chunks** (${(bytes / 1e6).toFixed(1)} MB of text).`,
    '',
    `- High (the passage would be dropped): **${high.length} chunks (${pct(high.length)})**`,
    `- Medium (kept, with a warning line): **${med.length} chunks (${pct(med.length)})**`,
    `- In the actual query-docs answers for those ${served} questions: ${servedRemoved} passages removed, ${servedWarned} warnings.`,
    `- upgrade-guide on ${UPGRADES.length} real upgrades: ${upRemoved} entries removed, ${upWarned} warnings.`,
    '',
    'Every flagged chunk is listed below for review. None of the packages is known to carry an injection, so each one is a false positive unless the excerpt says otherwise.',
    '',
    '| package | files | chunks | high | medium | answer: removed/warned |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '| upgrade | answer chars | removed | warned |',
    '|---|---|---|---|',
    ...upRows,
    '',
    '### Flagged chunks',
    '',
    '| level | package | source | rules | excerpt |',
    '|---|---|---|---|---|',
    ...[...high, ...med].map((f) => `| ${f.level} | ${f.pkg} | ${oneLine(f.source)} | ${f.reasons.join(', ')} | ${f.excerpt} |`),
    '',
    '## Detection on the adversarial corpus',
    '',
    `test/fixtures/injection/cases.ts: ${c.total} crafted passages (README, docs, docstrings, .d.ts comments, changelog and release entries, deprecation messages, descriptions, llms.txt).`,
    '',
    `- Flagged: **${c.detected}/${c.total}**; at the expected level (high = dropped, medium = warned): **${c.meetsExpected}/${c.total}**; high: ${c.high}.`,
    `- Hard negatives (installers piped to sh, API-key docs, chat templates, security docs quoting attacks): ${c.benignFlagged.length}/${c.benign} flagged.`,
    ...c.misses.map((m) => `  - miss: ${m}`),
    ...c.benignFlagged.map((m) => `  - false positive: ${m}`),
    '',
    'The corpus was written together with the rules, so this is a regression floor, not a detection rate.',
    '',
    '## Detection on passages the rules had not seen',
    '',
    'Three sets were written one at a time, each before a round of rule changes, and scored once before those changes:',
    '',
    '| set | written after | flagged | high (dropped) | benign flagged |',
    '|---|---|---|---|---|',
    '| heldout.ts | the first rules | 5/20 | 3/20 | 0/15 |',
    '| heldout2.ts | round 1 (generalized from heldout.ts misses) | 6/15 | 2/15 | 0/10 |',
    '| heldout3.ts | round 2 (generalized from heldout2.ts misses) | 3/15 | 2/15 | 0/10 |',
    '',
    'All three were used for tuning afterwards, so their current scores (printed by each script) are no longer unbiased.',
    'Read the column above as the expected catch rate on a phrasing the rules have not met: roughly 20 to 40 percent flagged.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(import.meta.dirname, 'RESULTS.md'), md);
  console.log(`\nchunks ${chunks}, high ${high.length} (${pct(high.length)}), medium ${med.length} (${pct(med.length)})`);
}

await main();
