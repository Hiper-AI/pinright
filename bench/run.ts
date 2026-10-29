/**
 * Benchmark: what an agent installs after reading Context7 vs what safectx
 * recommends, scored by the advisories Dependabot would raise today.
 *
 * For every library we compare three choices of version:
 *   c7Pinned  = the newest version Context7 has versioned docs for (the one an
 *               agent pins when it follows "/org/repo/vX.Y.Z");
 *   latest    = the registry's current release (what `npm install x` gives);
 *   safectx   = the newest stable version with no known advisory, past cooldown.
 * Each version is scored by its advisory count from deps.dev (= Dependabot
 * alerts on the day of the run). Hits the real APIs; results go to bench/RESULTS.md.
 *
 * Run: npm run bench
 */
import fs from 'node:fs';
import path from 'node:path';
import { getVersion } from '../src/advisories/depsdev.js';
import { searchLibraries } from '../src/context7.js';
import { resolvePackage } from '../src/mapping.js';
import { checkPackage } from '../src/verdict.js';
import { LIBRARIES } from './libraries.js';

interface Row {
  id: string;
  pkg?: string;
  eco?: string;
  c7Pinned?: string;
  c7PinnedAdv?: number;
  c7AnyPinnedVulnerable?: boolean;
  c7PinnedCount?: number;
  latest?: string;
  latestAdv?: number;
  safe?: string;
  safeAdv?: number;
  verdict: string;
  note?: string;
}

const PRERELEASE = /[-+.](alpha|beta|rc|canary|dev|preview|nightly|snapshot|pre|next|experimental)/i;

function normVersion(v: string): string {
  return v.replace(/^v/, '');
}

async function advisoryCount(eco: string, name: string, version: string): Promise<number | undefined> {
  const d = await getVersion(eco as never, name, version).catch(() => undefined);
  return d ? (d.advisoryKeys ?? []).length : undefined;
}

async function bench(id: string): Promise<Row> {
  const repo = id.split('/')[2] ?? id;
  const ref = await resolvePackage(id).catch(() => undefined);
  if (!ref) return { id, verdict: 'unmapped', note: 'could not map id to a package' };
  const v = await checkPackage(ref.ecosystem, ref.name);
  const row: Row = { id, pkg: ref.name, eco: ref.ecosystem, verdict: v.report.verdict, latest: v.report.latestVersion, safe: v.report.safeVersion };

  const libs = await searchLibraries(repo, 'getting started').catch(() => []);
  const lib = libs.find((l) => l.id === id);
  const pinned = (lib?.versions ?? []).filter((x) => !x.startsWith('__') && !PRERELEASE.test(x)).map(normVersion);
  row.c7PinnedCount = pinned.length;

  // Score every pinned version once, newest first by registry order.
  const scored: { version: string; adv?: number }[] = [];
  for (const p of pinned) scored.push({ version: p, adv: await advisoryCount(ref.ecosystem, ref.name, p) });
  const known = scored.filter((s) => s.adv !== undefined);
  if (known.length) {
    // "Newest" = the one that sorts highest; use a loose numeric compare.
    const key = (s: string) => s.split('.').map((n) => Number.parseInt(n, 10) || 0);
    known.sort((a, b) => {
      const ka = key(a.version), kb = key(b.version);
      for (let i = 0; i < 3; i++) if ((kb[i] ?? 0) !== (ka[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
      return 0;
    });
    row.c7Pinned = known[0].version;
    row.c7PinnedAdv = known[0].adv;
    row.c7AnyPinnedVulnerable = known.some((s) => (s.adv ?? 0) > 0);
  }
  if (row.latest) row.latestAdv = await advisoryCount(ref.ecosystem, ref.name, row.latest);
  if (row.safe) row.safeAdv = await advisoryCount(ref.ecosystem, ref.name, row.safe);
  return row;
}

const rows: Row[] = [];
const t0 = Date.now();
for (const id of LIBRARIES) {
  const row = await bench(id);
  rows.push(row);
  console.log(
    `${id.padEnd(40)} c7Pinned=${row.c7Pinned ?? '-'}(${row.c7PinnedAdv ?? '-'})  latest=${row.latest ?? '-'}(${row.latestAdv ?? '-'})  safectx=${row.safe ?? '-'}(${row.safeAdv ?? '-'})  ${row.verdict}`,
  );
}

const mapped = rows.filter((r) => r.pkg);
const withPinned = mapped.filter((r) => r.c7Pinned);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

const m = {
  libraries: rows.length,
  mapped: mapped.length,
  withPinned: withPinned.length,
  c7PinnedVulnerable: withPinned.filter((r) => (r.c7PinnedAdv ?? 0) > 0).length,
  c7AnyPinnedVulnerable: withPinned.filter((r) => r.c7AnyPinnedVulnerable).length,
  latestVulnerable: mapped.filter((r) => (r.latestAdv ?? 0) > 0).length,
  safeVulnerable: mapped.filter((r) => (r.safeAdv ?? 0) > 0).length,
  safeMissing: mapped.filter((r) => !r.safe).length,
  safeDiffersFromLatest: mapped.filter((r) => r.safe && r.latest && r.safe !== r.latest).length,
  alertsC7Pinned: sum(withPinned.map((r) => r.c7PinnedAdv)),
  alertsLatest: sum(mapped.map((r) => r.latestAdv)),
  alertsSafe: sum(mapped.map((r) => r.safeAdv)),
};

const lines: string[] = [];
lines.push(`# Benchmark: Context7 vs safectx`, '', `Run on ${new Date().toISOString().slice(0, 10)} against the live APIs, ${Math.round((Date.now() - t0) / 1000)} s.`, '');
lines.push('## Summary', '');
lines.push('| Metric | Value |', '|---|---|');
lines.push(`| Libraries in the set | ${m.libraries} |`);
lines.push(`| Mapped to a registry package | ${m.mapped} (${pct(m.mapped, m.libraries)}) |`);
lines.push(`| With versioned docs in Context7 | ${m.withPinned} |`);
lines.push(`| Newest Context7-pinned version has >= 1 advisory | ${m.c7PinnedVulnerable} of ${m.withPinned} (${pct(m.c7PinnedVulnerable, m.withPinned)}) |`);
lines.push(`| Any Context7-pinned version has >= 1 advisory | ${m.c7AnyPinnedVulnerable} of ${m.withPinned} (${pct(m.c7AnyPinnedVulnerable, m.withPinned)}) |`);
lines.push(`| Registry latest has >= 1 advisory | ${m.latestVulnerable} of ${m.mapped} (${pct(m.latestVulnerable, m.mapped)}) |`);
lines.push(`| safectx recommendation has >= 1 advisory | ${m.safeVulnerable} of ${m.mapped} (${pct(m.safeVulnerable, m.mapped)}) |`);
lines.push(`| safectx could not recommend a version | ${m.safeMissing} |`);
lines.push(`| safectx recommendation differs from registry latest | ${m.safeDiffersFromLatest} |`);
lines.push('', '### Dependabot alerts the day after install (sum of advisories over the set)', '');
lines.push('| Choice of version | Alerts |', '|---|---|');
lines.push(`| Newest version Context7 has docs for | ${m.alertsC7Pinned} |`);
lines.push(`| Registry latest | ${m.alertsLatest} |`);
lines.push(`| safectx recommendation | ${m.alertsSafe} |`);
lines.push('', '## Per library', '');
lines.push('| Context7 id | Package | Newest C7-pinned (advisories) | Latest (advisories) | safectx (advisories) | Verdict |', '|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| ${r.id} | ${r.eco ? `${r.eco}:${r.pkg}` : r.note ?? ''} | ${r.c7Pinned ? `${r.c7Pinned} (${r.c7PinnedAdv})` : '-'} | ${r.latest ? `${r.latest} (${r.latestAdv ?? '?'})` : '-'} | ${r.safe ? `${r.safe} (${r.safeAdv ?? '?'})` : '-'} | ${r.verdict} |`);
}
const out = path.join('bench', 'RESULTS.md');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`\n${lines.slice(0, 22).join('\n')}\n\nFull table: ${out}`);
