/**
 * upgrade-guide: what changes between two versions of a package, for an agent
 * about to move a project (or fix a Dependabot PR) from one to the other.
 *
 * Sources, all at the target version: changelog files, GitHub release notes for
 * the tags in (from, to], migration guides when a major is crossed, and for npm a
 * diff of the exported API in the .d.ts files. Breaking entries go first; the
 * advisories the move fixes come from the same verdict check-package uses.
 */
import { getPackage } from '../advisories/depsdev.js';
import { type AdvisoryInfo } from '../advisories/resolve.js';
import { config } from '../config.js';
import { chunkMarkdown, rank, select, type Chunk, type DocFile } from '../docs/retrieve.js';
import { type Ecosystem } from '../ecosystems.js';
import { packageMeta } from '../registry.js';
import { UntrustedOutput } from '../untrusted/index.js';
import { checkPackage, type Verdict } from '../verdict.js';
import { dedupeItems, extractItems, headingCategory, parseChangelog, sectionsInRange, type Category, type ChangeItem } from './changelog.js';
import { apiSurface, diffSurfaces, type EntryDiff } from './dts.js';
import { announcementLink, changelogDocs, fetchAnnouncement, githubReleases, guideDocs, majorMarkers, type ReleaseNote, type UpgradeDoc } from './sources.js';
import { compareVersions, crossesLine, inUpgradeRange, isPrereleaseVersion, lineOf, majorsInRange, resolveVersionSpec, toSemver } from './versions.js';

export interface UpgradeOptions {
  ecosystem: Ecosystem;
  name: string;
  from: string;
  to?: string;
  query?: string;
  budgetChars?: number;
}

export interface UpgradeResult {
  text: string;
  from?: string;
  to?: string;
  crossesMajor?: boolean;
}

/** What an upgrade has to act on; used to rank guide sections when no query is given. */
const UPGRADE_QUERY = 'breaking change remove removed rename renamed deprecate deprecated migration migrate upgrade required default config replaced moved package';
const MAX_ANNOUNCEMENTS = 3;

const LABEL: Record<Exclude<Category, 'other'>, string> = {
  breaking: 'BREAKING',
  package: 'NEW PACKAGE',
  config: 'CONFIG/DEFAULT',
  deprecation: 'DEPRECATED',
};

// ---------------------------------------------------------------- items ----

function itemFile(i: ChangeItem): DocFile {
  return { label: i.source, url: i.url, content: '', kind: 'markdown', versionAccurate: true };
}

/** Breaking first, then the versions that open a new line, then what the query asks about. */
export function rankItems(items: ChangeItem[], from: string, query?: string): (ChangeItem & { score: number })[] {
  const base: Record<Category, number> = { breaking: 3, package: 3, config: 2.5, deprecation: 1.5, other: 0 };
  const q = new Map<ChangeItem, number>();
  if (query?.trim()) {
    const chunks: Chunk[] = items.map((i) => ({ file: itemFile(i), title: i.version, text: i.text, score: 0 }));
    const ranked = rank(chunks, query);
    ranked.forEach((c) => q.set(items[chunks.indexOf(c)], c.score));
  }
  return items
    .map((i) => {
      // The release that opens a new line (16.0.0, 2.0.0b1) is where most breaking notes live.
      const s = toSemver(i.version) ?? '';
      const opensLine = lineOf(i.version) !== lineOf(from) && /^\d+\.0\.0|^0\.\d+\.0/.test(s);
      // An entry the maintainers labeled breaking beats one that only says "remove".
      const explicit = /\[breaking\]|breaking change|\bbreaking\b|!:|⚠/i.test(i.text) ? 1 : 0;
      return { ...i, score: base[i.category] + (opensLine ? 1.5 : 0) + explicit + Math.min(q.get(i) ?? 0, 6) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Items that fit `budget`, shown grouped by version (oldest first) with one citation per source. */
export function formatItems(items: ChangeItem[], budget: number): { text: string; used: number; shown: number } {
  const picked: ChangeItem[] = [];
  let used = 0;
  for (const i of items) {
    const size = i.text.length + 20;
    if (used + size > budget) continue;
    picked.push(i);
    used += size;
  }
  if (!picked.length) return { text: '', used: 0, shown: 0 };
  const groups = new Map<string, ChangeItem[]>();
  for (const i of picked) {
    const k = `${i.version}\u0000${i.source}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const keys = [...groups.keys()].sort((a, b) => (compareVersions(a.split('\u0000')[0], b.split('\u0000')[0]) ?? 0));
  const lines: string[] = [];
  for (const k of keys) {
    const list = groups.get(k) as ChangeItem[];
    lines.push(`${list[0].version}, ${list[0].source} ${list[0].url}`);
    for (const i of list) {
      const tag = i.category === 'other' ? '' : `${LABEL[i.category]}: `;
      lines.push(`- ${tag}${i.text.replace(/\n+/g, '\n  ')}`);
    }
  }
  const text = lines.join('\n');
  return { text, used: text.length, shown: picked.length };
}

// ------------------------------------------------------------- API diff ----

function trimSig(s: string, n = 180): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** The .d.ts diff, worst first, capped at `budget` characters. */
export function formatApiDiff(d: { diffs: EntryDiff[]; removedEntries: string[]; addedEntries: string[]; skipped?: string[] }, budget: number, query?: string): string {
  const qTerms = (query ?? '').toLowerCase().split(/[^a-z0-9_$]+/).filter((t) => t.length > 2);
  const hit = (name: string) => qTerms.some((t) => name.toLowerCase().includes(t));
  const lines: string[] = [];
  if (d.removedEntries.length) lines.push(`- BREAKING: entry points removed: ${d.removedEntries.join(', ')}`);
  if (d.skipped?.length) lines.push(`Not compared (too many files to follow, or unreadable): ${d.skipped.join(', ')}`);
  // The root entry is what most code imports; subpaths get a shorter listing.
  const diffs = [...d.diffs].sort((a, b) => (a.entry === '.' ? -1 : b.entry === '.' ? 1 : b.removed.length - a.removed.length));
  for (const e of diffs) {
    const root = e.entry === '.';
    const where = root ? 'root' : e.entry;
    lines.push(`${where}: ${e.removed.length} exports removed, ${e.changed.length} changed, ${e.added.length} added.`);
    const removed = [...e.removed].sort((a, b) => Number(hit(b.name)) - Number(hit(a.name)));
    const maxRemoved = root ? 40 : 15;
    if (removed.length) {
      const shown = removed.slice(0, maxRemoved).map((r) => `${r.name} (${r.kind})`);
      lines.push(`- BREAKING: removed: ${shown.join(', ')}${removed.length > maxRemoved ? `, +${removed.length - maxRemoved} more` : ''}`);
    }
    const changed = [...e.changed].sort((a, b) => Number(hit(b.name)) - Number(hit(a.name)) || Number(Boolean(b.removedMembers?.length)) - Number(Boolean(a.removedMembers?.length)));
    for (const c of changed.slice(0, root ? 15 : 4)) {
      if (c.removedMembers?.length) lines.push(`- BREAKING: ${c.kind} ${c.name}: members removed: ${c.removedMembers.slice(0, 12).join(', ')}${c.removedMembers.length > 12 ? ', ...' : ''}`);
      else lines.push(`- changed ${c.kind} ${c.name}:\n  before: ${trimSig(c.before)}\n  after:  ${trimSig(c.after)}`);
    }
    if (changed.length > (root ? 15 : 4)) lines.push(`- ... and ${changed.length - (root ? 15 : 4)} more changed declarations`);
  }
  if (d.addedEntries.length) lines.push(`New entry points: ${d.addedEntries.slice(0, 12).join(', ')}${d.addedEntries.length > 12 ? ', ...' : ''}`);
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > budget) {
      out += '\n- ... (truncated)';
      break;
    }
    out += (out ? '\n' : '') + l;
  }
  return out;
}

// ---------------------------------------------------------------- guides ----

/** MDX comments and bare JSX tag lines (<Tabs>, <Callout>) carry no text an agent needs. */
export function cleanMdx(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function guideChunks(docs: UpgradeDoc[], query: string | undefined, budget: number, out?: UntrustedOutput): Chunk[] {
  const files: DocFile[] = docs.map((d) => ({ label: d.label, url: d.url, content: cleanMdx(d.content), kind: 'markdown', versionAccurate: d.versionAccurate }));
  const chunks = files.flatMap((f) => chunkMarkdown(f.content, /\.rst$/i.test(f.url)).map((p) => ({ file: f, title: p.title, text: p.text, score: 0 })));
  const ranked = rank(chunks, `${query ?? ''} ${UPGRADE_QUERY}`);
  for (const c of ranked) {
    // Every section of a migration guide is about the upgrade; the terms only order them.
    c.score = Math.max(c.score, 0.1);
    const cat = headingCategory(c.title);
    if (cat === 'breaking' || cat === 'config' || cat === 'deprecation') c.score *= 1.5;
    // "`middleware` to `proxy`", "Renamed X": renames break code silently.
    if (/\brenam|→|`\s+to\s+`/i.test(c.title)) c.score *= 1.5;
    if (/\b(what'?s next|share|author|comments?|read next|stay informed|contributors?|sponsors?)\b/i.test(c.title)) c.score *= 0.2;
  }
  ranked.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique = ranked.filter((c) => {
    const k = c.text.replace(/\s+/g, ' ').slice(0, 200).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out ? out.select(unique, (pool) => select(pool, budget, 6), (c) => c.file.label) : select(unique, budget, 6);
}

/**
 * The other section titles of a guide written for the major being crossed: the
 * excerpts above can only hold a few sections, and a title like "`middleware` to
 * `proxy`" is often all the agent needs to know what to look up.
 */
export function guideToc(docs: UpgradeDoc[], shown: Chunk[], majors: number[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  const shownTitles = new Set(shown.map((c) => c.title));
  for (const d of docs) {
    if (!majorMarkers(`${d.label} ${d.url}`).some((m) => majors.includes(m))) continue;
    const titles = [...new Set(chunkMarkdown(cleanMdx(d.content), /\.rst$/i.test(d.url)).map((c) => c.title))].filter((t) => t && !shownTitles.has(t));
    // Breaking, deprecated and renamed sections first; sub-sections only when they name a change themselves.
    const notable = (t: string) => {
      const c = headingCategory(t);
      return c === 'breaking' || c === 'deprecation' || c === 'config' || /\brenam|\bremov|\bto\b|→/i.test(t);
    };
    const leaves = [...new Set(titles.map((t) => t.split(' > ').slice(1)).filter((p) => p.length === 1 || (p.length > 1 && notable(p[p.length - 1]))).map((p) => p.join(' > ')))]
      .map((t, i) => ({ t, i, n: notable(t) ? 0 : 1 }))
      .sort((a, b) => a.n - b.n || a.i - b.i)
      .map((x) => x.t);
    if (!leaves.length) continue;
    let line = `Other sections of ${d.label}: `;
    for (const l of leaves) {
      if (used + line.length + l.length + 2 > maxChars) break;
      line += `${l}; `;
    }
    line = line.replace(/; $/, '.');
    used += line.length;
    lines.push(line);
    if (used >= maxChars) break;
  }
  return lines.join('\n');
}

/** One untrusted block per excerpt; the table of contents (the guides' own headings) rides in the last one. */
function formatGuides(chunks: Chunk[], out: UntrustedOutput, toc = ''): string {
  const parts: string[] = [];
  chunks.forEach((c, i) => {
    // The heading is already in the title line.
    const body = c.text.replace(/^#{1,6}\s+.*\n+/, '');
    const text = [
      `### ${c.title || c.file.label}`,
      `Source: ${c.file.label}${c.file.versionAccurate ? '' : ' (current site, may describe a newer version)'} ${c.file.url}`,
      body,
      ...(toc && i === chunks.length - 1 ? ['', toc] : []),
    ].join('\n');
    parts.push(out.block(text, c.file.label, out.scan(i === chunks.length - 1 ? `${body}\n${toc}` : body)));
    parts.push('');
  });
  return parts.join('\n').trim();
}

// -------------------------------------------------------------- security ----

function advKey(a: AdvisoryInfo): string[] {
  return [a.id, ...a.aliases];
}

function advLine(a: AdvisoryInfo): string {
  const cve = a.aliases.find((x) => x.startsWith('CVE-'));
  const sev = a.severity ?? (a.cvss3Score != null ? `CVSS ${a.cvss3Score}` : undefined);
  return `  - ${a.id}${cve ? ` (${cve})` : ''}${sev ? ` [${sev}]` : ''}: ${a.title ?? ''}`.trimEnd();
}

export function securitySection(from: Verdict, to: Verdict, fromVersion: string, toVersion: string): string {
  const lines: string[] = [];
  const fr = from.report.requested;
  const tr = to.report.requested;
  const date = to.report.checkedAt.slice(0, 10);
  if (!fr || fr.verdict === 'unknown' || from.report.verdict === 'unknown') {
    lines.push(`Security: could not check ${fromVersion} (${from.report.reason ?? 'a data source did not answer'}).`);
  }
  if (!tr || tr.verdict === 'unknown' || to.report.verdict === 'unknown') {
    lines.push(`Security: could not check ${toVersion} (${to.report.reason ?? 'a data source did not answer'}); treat it as unverified.`);
    return lines.join('\n');
  }
  const toKeys = new Set(tr.advisories.flatMap(advKey));
  const fixed = (fr?.advisories ?? []).filter((a) => !advKey(a).some((k) => toKeys.has(k)));
  if (fr && fr.verdict !== 'unknown') {
    lines.push(`Security: ${fromVersion} has ${fr.advisories.length || 'no'} known advisor${fr.advisories.length === 1 ? 'y' : 'ies'}; ${toVersion} has ${tr.advisories.length || 'none'}${tr.advisories.length ? ` known advisor${tr.advisories.length === 1 ? 'y' : 'ies'}` : ''} (deps.dev + osv.dev, ${date}).`);
  }
  if (fixed.length) {
    lines.push(`Fixed by moving to ${toVersion}:`);
    for (const a of fixed.slice(0, 8)) lines.push(advLine(a));
    if (fixed.length > 8) lines.push(`  - ... and ${fixed.length - 8} more`);
  }
  if (tr.advisories.length) {
    lines.push(`WARNING: still present at ${toVersion}:`);
    for (const a of tr.advisories.slice(0, 5)) lines.push(advLine(a));
    const safe = to.report.safeVersion;
    if (safe && safe !== toVersion) lines.push(`  The newest version without known advisories is ${safe}.`);
  }
  if (tr.verdict === 'malicious') lines.push(`WARNING: ${toVersion} is flagged as MALWARE. Do not install it.`);
  if (tr.verdict === 'deprecated') lines.push(`NOTE: ${toVersion} is deprecated${tr.deprecatedReason ? `: ${tr.deprecatedReason}` : '.'}`);
  return lines.join('\n');
}

// ------------------------------------------------------------- assembly ----

function oldestInRange(versions: { versionKey: { version: string }; publishedAt?: string }[], from: string, to: string): string | undefined {
  return versions
    .filter((v) => v.publishedAt && inUpgradeRange(v.versionKey.version, from, to))
    .map((v) => v.publishedAt as string)
    .sort()[0];
}

function releaseUrl(meta: { repo?: { owner: string; repo: string } }): string | undefined {
  return meta.repo ? `https://github.com/${meta.repo.owner}/${meta.repo.repo}/releases` : undefined;
}

export async function upgradeGuide(opts: UpgradeOptions): Promise<UpgradeResult> {
  const budget = opts.budgetChars ?? config.docsBudgetChars;
  const { ecosystem: eco, name } = opts;
  const pkg = await getPackage(eco, name);
  if (!pkg?.versions.length) return { text: `No package "${name}" in ${eco} (deps.dev). Check the name.` };
  const all = pkg.versions.map((v) => v.versionKey.version);

  const from = resolveVersionSpec(opts.from, all);
  if (!from) return { text: `${name} (${eco}) has no published version matching "${opts.from}".` };
  const fromV = await checkPackage(eco, name, from);
  const r = fromV.report;

  let to: string | undefined;
  let why = '';
  if (opts.to) {
    to = resolveVersionSpec(opts.to, all);
    if (!to) return { text: `${name} (${eco}) has no published version matching "${opts.to}".` };
    if (to !== opts.to.replace(/^v(?=\d)/, '')) why = ` ("${opts.to}" resolved to the newest matching release)`;
  } else {
    const fromVulnerable = r.requested && r.requested.verdict !== 'ok' && r.requested.verdict !== 'unknown';
    const sameLineAhead = r.safeVersionSameLine && (compareVersions(r.safeVersionSameLine, from) ?? 0) > 0 ? r.safeVersionSameLine : undefined;
    to = fromVulnerable && sameLineAhead ? sameLineAhead : (fromVulnerable && r.safeVersionNearestLine) || r.safeVersion || sameLineAhead;
    if (to) {
      why = to === r.safeVersionSameLine && to !== r.safeVersion ? ' (recommended: newest version on the same release line with no known advisories)'
        : to === r.safeVersionNearestLine && to !== r.safeVersion ? ` (recommended: nearest newer release line, ${r.nearestLine}, with a version free of known advisories; newest safe is ${r.safeVersion})`
        : ' (recommended: newest version with no known advisories)';
    }
  }
  if (!to) {
    return { text: `No version of ${name} (${eco}) is free of known advisories${r.verdict === 'unknown' ? ` (or a source did not answer: ${r.reason})` : ''}; pass "to" explicitly.`, from };
  }
  const cmp = compareVersions(to, from);
  if (cmp === undefined || cmp <= 0) return { text: `${to} is not newer than ${from}; nothing to upgrade.`, from, to };

  const crossing = crossesLine(from, to);
  const [toV, meta] = await Promise.all([checkPackage(eco, name, to), packageMeta(eco, name, to)]);
  const oldest = oldestInRange(pkg.versions, from, to);

  const notes: string[] = [];
  const [changelogs, releases, guides, api] = await Promise.all([
    changelogDocs(meta, from, to).catch(() => [] as UpgradeDoc[]),
    githubReleases(meta, from, to, oldest).catch(() => ({ notes: [] as ReleaseNote[], note: undefined })),
    crossing ? guideDocs(meta, from, to).catch(() => [] as UpgradeDoc[]) : Promise.resolve([] as UpgradeDoc[]),
    eco === 'npm'
      ? Promise.all([apiSurface(name, from), apiSurface(name, to)]).catch(() => [undefined, undefined] as const)
      : Promise.resolve([undefined, undefined] as const),
  ]);
  if (releases.note) notes.push(releases.note);
  // Changelogs, release bodies and guides are third-party text: normalize them before parsing.
  const out = new UntrustedOutput();
  for (const d of [...changelogs, ...guides]) d.content = out.prepare(d.content, d.label);
  for (const n of releases.notes) n.body = out.prepare(n.body ?? '', `GitHub release ${n.tag}`);

  // Changelog entries for (from, to]. A "changelog" without version sections is a migration guide (zod's v4/changelog.mdx).
  const majors = majorsInRange(from, to);
  const items: ChangeItem[] = [];
  const extraGuides: UpgradeDoc[] = [];
  let changelogVersions = 0;
  for (const doc of changelogs) {
    const sections = parseChangelog(doc.content);
    if (!sections.length) {
      if (crossing && majorMarkers(doc.label).some((m) => majors.includes(m))) extraGuides.push(doc);
      continue;
    }
    const inRange = sectionsInRange(sections, from, to);
    changelogVersions += inRange.length;
    for (const s of inRange) items.push(...extractItems(s, doc.label, doc.url));
  }
  for (const n of releases.notes) {
    items.push(...extractItems({ version: n.version, title: n.name, body: n.body }, `GitHub release ${n.tag}`, n.url));
  }
  // Release bodies that only link to an announcement post (TypeScript's): read the post, newest line first.
  // Only the first release of each minor: patch releases link to unrelated posts (security write-ups).
  const firstOfMinor = new Map<string, ReleaseNote>();
  for (const n of [...releases.notes].sort((a, b) => compareVersions(a.version, b.version) ?? 0)) {
    const s = toSemver(n.version);
    const key = s ? s.split('.').slice(0, 2).join('.') : n.version;
    if (!firstOfMinor.has(key)) firstOfMinor.set(key, n);
  }
  const links = new Map<string, string>();
  for (const n of [...firstOfMinor.values()].reverse()) {
    const u = announcementLink(n.body);
    if (u && !links.has(u)) links.set(u, n.tag);
  }
  const announcements = (
    await Promise.all([...links.entries()].slice(0, MAX_ANNOUNCEMENTS).map(([u, tag]) => fetchAnnouncement(u, tag).catch(() => undefined)))
  ).filter((d): d is UpgradeDoc => Boolean(d));
  for (const d of announcements) d.content = out.prepare(d.content, d.label);

  // An entry that addresses the agent with instructions is dropped; the rest of its release stays.
  const unique = out.select(dedupeItems(items), (pool) => pool, (i) => i.source);
  const ranked = rankItems(unique, from, opts.query);
  const act = ranked.filter((i) => i.category === 'breaking' || i.category === 'package' || i.category === 'config');
  const deprecations = ranked.filter((i) => i.category === 'deprecation');
  const other = opts.query?.trim() ? ranked.filter((i) => i.category === 'other' && i.score >= 2) : [];

  // ---- assemble within the budget, carrying unused share forward ----
  const header: string[] = [];
  header.push(`Upgrade guide: ${name} (${eco}) ${from} -> ${to}${why}.`);
  header.push(
    crossing
      ? `This crosses a release line (${lineOf(from)}.x -> ${lineOf(to)}.x): expect breaking changes. Do not write code or config for ${to} from memory of ${from}.`
      : `Same release line (${lineOf(from)}.x): no API break is expected, but read the entries below.`,
  );
  if (!opts.to && r.safeVersion && r.safeVersion !== to) header.push(`Newest safe overall is ${r.safeVersion}; call upgrade-guide with to="${r.safeVersion}" for that move.`);
  if (isPrereleaseVersion(to)) header.push(`${to} is a pre-release.`);
  const sec = securitySection(fromV, toV, from, to);

  const parts: string[] = [header.join('\n'), sec];
  let carry = 0;
  const share = (f: number) => Math.floor(budget * f);
  // Across a major the migration guide carries most of the weight; within a line the changelog does.
  const W = crossing ? { act: 0.3, api: 0.17, guide: 0.4, dep: 0.08 } : { act: 0.5, api: 0.2, guide: 0, dep: 0.12 };

  const actOut = formatItems(act, share(W.act));
  carry += share(W.act) - actOut.used;
  const itemsBlock = (text: string) => out.block(text, `${name} changelogs and release notes, sources per version line`);
  if (actOut.text) parts.push(`## Breaking changes, config/default changes and new packages (changelogs and release notes)\n${itemsBlock(actOut.text)}`);

  let apiText = '';
  const [apiFrom, apiTo] = api;
  if (apiFrom && apiTo && apiFrom.entries.size && apiTo.entries.size) {
    apiText = formatApiDiff(diffSurfaces(apiFrom, apiTo), share(W.api) + Math.floor(Math.max(0, carry) / 3), opts.query);
  } else if (eco === 'npm' && apiFrom && apiFrom.entries.size && apiTo && !apiTo.entries.size) {
    apiText = `- BREAKING: ${name}@${from} ships type definitions for ${[...apiFrom.entries.keys()].join(', ')}; ${name}@${to} has none for its root entry. The public API changed or moved.`;
  }
  if (apiText) {
    parts.push(`## Exported API diff (.d.ts, ${name}@${from} vs ${name}@${to}, https://cdn.jsdelivr.net/npm/${name}@${to}/)\n${out.block(apiText, `.d.ts of ${name}@${from} and @${to}`)}`);
    carry += share(W.api) - apiText.length;
  } else carry += share(W.api);

  const allGuides = [...guides, ...extraGuides, ...announcements];
  if (allGuides.length) {
    const gBudget = share(W.guide) + Math.max(0, carry);
    const tocBudget = Math.min(1500, Math.floor(gBudget * 0.15));
    const chunks = guideChunks(allGuides, opts.query, gBudget - tocBudget, out);
    const toc = guideToc(allGuides, chunks, majors, tocBudget);
    const used = chunks.reduce((a, c) => a + c.text.length + c.title.length + 80, 0) + toc.length;
    carry = gBudget - used;
    if (chunks.length) parts.push(`## Migration guide and release announcement excerpts\n${formatGuides(chunks, out, toc)}`);
  } else carry += share(W.guide);

  const depOut = formatItems(deprecations, share(W.dep) + Math.max(0, carry));
  carry = share(W.dep) + Math.max(0, carry) - depOut.used;
  if (depOut.text) parts.push(`## Deprecations\n${itemsBlock(depOut.text)}`);

  if (other.length) {
    const otherOut = formatItems(other, Math.max(0, carry));
    if (otherOut.text) parts.push(`## Other changes matching "${opts.query}"\n${itemsBlock(otherOut.text)}`);
  }

  const counts = [
    `${changelogVersions} changelog version${changelogVersions === 1 ? '' : 's'}`,
    `${releases.notes.length} GitHub release${releases.notes.length === 1 ? '' : 's'}`,
    `${allGuides.length} guide${allGuides.length === 1 ? '' : 's'}/announcement${allGuides.length === 1 ? '' : 's'}`,
    eco === 'npm' ? (apiText ? 'a .d.ts API diff' : 'no .d.ts API diff (no bundled types at one of the versions)') : 'no API diff (npm only)',
  ];
  if (!act.length && !allGuides.length && !apiText) {
    notes.push(`No breaking changes were found in the sources read.${releaseUrl(meta) ? ` Check ${releaseUrl(meta)} before assuming there are none.` : ''}`);
  }
  parts.push(`Read: ${counts.join(', ')}. Entries marked BREAKING/CONFIG/NEW PACKAGE need action; for the ${to} API itself call get-docs with libraryId "${eco}:${name}@${to}".`);
  if (notes.length) parts.push(notes.join('\n'));
  // What was removed goes right under the header, where it is read first.
  if (out.notes.length) parts.splice(1, 0, out.notes.join('\n'));
  out.record(eco, name, to);
  return { text: parts.filter(Boolean).join('\n\n'), from, to, crossesMajor: crossing };
}
