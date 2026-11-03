/**
 * Changelogs and release notes, read as data: split a file into one section per
 * version, keep the versions in (from, to], and pull out the entries an upgrade
 * has to act on (breaking changes, removed or renamed APIs, config and default
 * changes, packages that split off, deprecations).
 *
 * Headings come in many styles: "## 1.2.3", "## [1.2.3] - 2024-01-01",
 * "# v2.0b3 (2023-05-01)", setext/RST underlines ("5.0.0 / 2024-09-10" over
 * "====="), and "langchain==1.0.0" in monorepo release titles.
 */
import { closingHashes } from '../docs/retrieve.js';
import { inUpgradeRange, versionInHeading } from './versions.js';

export interface VersionSection {
  version: string;
  title: string;
  body: string;
}

export type Category = 'breaking' | 'config' | 'package' | 'deprecation' | 'other';

export interface ChangeItem {
  category: Category;
  version: string;
  text: string;
  /** Where it came from: "CHANGELOG.md (next@16.4.3)", "GitHub release v16.0.0". */
  source: string;
  url: string;
}

interface Heading {
  line: number;
  /** Lines the heading itself takes (2 for setext/RST). */
  span: number;
  level: number;
  text: string;
}

const UNDERLINE = /^\s*([=\-~^*+#])\1{2,}\s*$/;

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  const rstLevels: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const atx = line.match(/^(#{1,6})\s+(\S.*)$/);
    if (atx) {
      out.push({ line: i, span: 1, level: atx[1].length, text: closingHashes(atx[2]) });
      continue;
    }
    const next = lines[i + 1] ?? '';
    const u = next.match(UNDERLINE);
    if (u && line.trim() && !UNDERLINE.test(line) && !/^\s*[-*+]\s/.test(line) && line.trim().length <= 120) {
      // Setext in markdown is "=" (1) and "-" (2); RST levels follow order of first appearance.
      const ch = u[1];
      if (!rstLevels.includes(ch)) rstLevels.push(ch);
      const level = ch === '=' ? 1 : ch === '-' ? 2 : 2 + rstLevels.indexOf(ch);
      out.push({ line: i, span: 2, level, text: line.trim() });
      i++;
    }
  }
  return out;
}

/** One section per version heading, at the heading level most version headings use. */
export function parseChangelog(content: string): VersionSection[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const hs = headings(lines);
  const withVersion = hs.map((h) => ({ ...h, version: versionInHeading(h.text.replace(/[*_`]/g, '')) }));
  const counts = new Map<number, number>();
  for (const h of withVersion) if (h.version) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  if (!counts.size) return [];
  const level = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const out: VersionSection[] = [];
  for (let k = 0; k < withVersion.length; k++) {
    const h = withVersion[k];
    if (h.level !== level || !h.version) continue;
    const end = withVersion.slice(k + 1).find((n) => n.level <= level)?.line ?? lines.length;
    out.push({ version: h.version, title: h.text, body: lines.slice(h.line + h.span, end).join('\n').trim() });
  }
  return out;
}

export function sectionsInRange(sections: VersionSection[], from: string, to: string): VersionSection[] {
  return sections.filter((s) => inUpgradeRange(s.version, from, to));
}

// ------------------------------------------------------------- classify ----

const BREAKING =
  /(?<!non[- ])\bbreaking\b|⚠|\bremov(e|ed|es|al|ing)\b|\bdrop(s|ped|ping)?\b(?!\s*-?down)|\bno longer\b|\brenam(e|ed|es|ing)\b|\bnow requires?\b|\bis now required\b|\bmust (now )?(be|use|set|pass|specify)\b|\bnot supported\b|\bunsupported\b|\bminimum (supported )?(node|python|version|typescript)|\breplaced (by|with)\b|\bincompatib|\bbackwards?[- ]incompat|\b(an|is now an?) error\b/i;
/** Under a "Features" or "Bug fixes" heading only explicit wording counts. */
const STRONG_BREAKING = /(?<!non[- ])\bbreaking\b|⚠|\bno longer\b|\brenamed\b|\bdrop(s|ped)? support\b|\bremoved\b|\bbackwards?[- ]incompat/i;
/** Wording that is breaking on its own, whatever the object. */
const EXPLICIT = /(?<!non[- ])\bbreaking\b|⚠|\bno longer\b|\bbackwards?[- ]incompat|\bnot supported\b|\bunsupported\b|\bdrop(s|ped)? (support|python|node)/i;
/** "Remove X" is only an API change when X looks like API. */
const API_SIGNAL = /`[^`]+`|\b(support|parameter|param|argument|option|flag|method|function|class|field|attribute|property|api|export|module|setting|config|command|hook|endpoint|signature|keyword|deprecated|python|node(\.js)?)\b/i;
const INTERNAL = /\b(docs?|documentation|tests?|xfail|typos?|comments?|ci|lint(ing)?|unused|redundant|dead code|internals?|readme|changelog|benchmarks?|type ignores?|debug (log|assert)|debug_assert|examples?)\b/i;
const CONFIG = /\bdefaults?\b.*\b(now|changed?|to|is)\b|\bnow defaults?\b|\bdefault value\b|tsconfig|\bconfig(uration)?\b.*\b(option|key|field|setting)\b|\b(option|flag|setting)\b.*\b(renamed|removed|now|changed)\b|\benv(ironment)? var/i;
const PACKAGE =
  /\b(moved|split|extracted|migrated)\b.{0,40}\b(separate|own|new|standalone)?\s*(package|module|library)\b|\bnow (lives|available) in `?[\w@./-]+`?|\binstall `?[\w@./-]+`? separately|\b(separate|standalone) package\b|\brequires? (installing|the) `?[\w@./-]+`? package/i;
const DEPRECATION = /\bdeprecat/i;
const QUIET_HEADING = /\b(features?|added|new|enhancements?|improvements?|fix(es|ed)?|bug ?fixes|bugs|perf(ormance)?|internal|docs?|documentation|chores?|dependenc(y|ies)|misc|tests?|ci|refactor|contributors?|credits|thanks|commits?|full changelog|other changes|patch changes|minor changes)\b/i;
/** Conventional-commit types that never change the API. */
const NOISE_COMMIT = /^\s*(docs?|chore|test|tests|ci|build|style|refactor|perf|examples?|evals?|bench(mark)?s?)(\([^)]*\))?:|^\s*revert\b/i;

export function headingCategory(heading: string): Category | 'quiet' | undefined {
  if (/(?<!non[- ])breaking|backwards?[- ]incompat|⚠|(?<!non-)incompatible|migration|upgrade notes?/i.test(heading)) return 'breaking';
  if (/\bremov|\bdropp?ed\b/i.test(heading)) return 'breaking';
  if (/deprecat/i.test(heading)) return 'deprecation';
  if (/\bconfig|\bdefaults?\b|behaviou?r(al)? changes?/i.test(heading)) return 'config';
  if (QUIET_HEADING.test(heading)) return 'quiet';
  return undefined;
}

export function classify(text: string, under?: Category | 'quiet'): Category {
  const t = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Conventional commits: "feat!: ..." and "BREAKING CHANGE:".
  if (/^\s*\w+(\([^)]*\))?!:/.test(t) || /BREAKING[ -]CHANGE/.test(t)) return 'breaking';
  if (NOISE_COMMIT.test(t)) return 'other';
  if (PACKAGE.test(t)) return 'package';
  const removesDeprecated = DEPRECATION.test(t) && /\b(remov|drop)/i.test(t);
  if (DEPRECATION.test(t) && !removesDeprecated) return under === 'breaking' ? 'breaking' : 'deprecation';
  if (under && under !== 'quiet') {
    if (under === 'config' && BREAKING.test(t)) return 'breaking';
    return under;
  }
  // Removing a test, a doc page or dead code is not an upgrade concern.
  const housekeeping = !EXPLICIT.test(t) && (INTERNAL.test(t) || !API_SIGNAL.test(t));
  if (under === 'quiet') return STRONG_BREAKING.test(t) && !housekeeping ? 'breaking' : 'other';
  if (BREAKING.test(t)) {
    if (housekeeping) return 'other';
    return CONFIG.test(t) ? 'config' : 'breaking';
  }
  if (CONFIG.test(t) && /\b(now|changed?|no longer|instead)\b/i.test(t)) return 'config';
  return 'other';
}

/**
 * A prose section explaining one change. Long prose mentions "removed" and
 * "default" in passing, so its heading decides; the body only counts when it
 * says "breaking" outright.
 */
export function classifyProse(heading: string, body: string, under?: Category | 'quiet'): Category {
  if (under && under !== 'quiet') return under;
  if (heading && STRONG_BREAKING.test(heading)) return 'breaking';
  if (heading && DEPRECATION.test(heading)) return 'deprecation';
  if (heading && PACKAGE.test(heading)) return 'package';
  if (/(?<!non[- ])\bbreaking change|⚠|backwards?[- ]incompat/i.test(body)) return 'breaking';
  return 'other';
}

/** Markdown noise that costs tokens: PR links, author handles, commit hashes, images. */
export function tidy(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // "by [@user](...) in [#123](...)", "in [pydantic/pydantic-core#1322](...)"
    // (?<!\s): a whitespace run is tried once, from its start, not from every space in it (quadratic).
    .replace(/(?<!\s)\s+by \[@[\w-]+\]\([^)]*\)/g, '')
    .replace(/(?<!\s)\s+in \[[\w./-]*#\d+\]\([^)]*\)/g, '')
    .replace(/(?<!\s)\s+in \[[\w./-]*#\d+\]/g, '')
    .replace(/(?<!\s)\s*\(?\[#\d+\]\([^)]*\)\)?/g, '')
    .replace(/(?<!\s)\s*\(?\[[0-9a-f]{7,40}\]\([^)]*\)\)?/g, '')
    .replace(/(?<!\s)\s+by @[\w-]+(\[bot\])?( in (https?:\/\/\S+|#\d+))?/g, '')
    .replace(/(?<!\s)\s*in https:\/\/github\.com\/\S+\/pull\/\d+/g, '')
    .replace(/(?<!\s)\s*\(https:\/\/github\.com\/\S+\/(pull|issues|commit)\/\w+\)/g, '')
    .replace(/^(Commit\s+)?\[?`?[0-9a-f]{7,40}`?\]?(\([^)]*\))?:?\s+/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/(?<!\s)\s+in$/gm, '')
    .trim();
}

const MAX_ITEM = 650;

function cap(text: string): string {
  if (text.length <= MAX_ITEM) return text;
  let t = `${text.slice(0, MAX_ITEM).replace(/\s+\S*$/, '')} ...`;
  if ((t.match(/```/g) ?? []).length % 2) t += '\n```';
  return t;
}

/**
 * The entries of one version section. A bullet is one entry (with its indented
 * continuation and a code block right after it). Prose under a heading is one
 * entry titled by the heading, since release notes often explain each change in
 * its own "### ⚠️ ..." section rather than a list.
 */
export function extractItems(section: VersionSection, source: string, url: string): ChangeItem[] {
  const out: ChangeItem[] = [];
  const lines = section.body.replace(/\r\n/g, '\n').split('\n');
  let under: Category | 'quiet' | undefined = headingCategory(section.title) === 'breaking' ? 'breaking' : undefined;
  let heading = '';
  let bullet: string[] = [];
  let prose: string[] = [];
  let last: 'bullet' | 'prose' = 'prose';
  let inFence = false;
  const push = (raw: string, withHeading: boolean) => {
    const body = tidy(raw);
    if (body.replace(/```[\s\S]*?```/g, '').trim().length < 8 || !/[a-z]/i.test(body)) return;
    const text = withHeading && heading ? `${tidy(heading)}: ${body}` : body;
    out.push({ category: withHeading ? classifyProse(heading, body, under) : classify(body, under), version: section.version, text: cap(text), source, url });
  };
  const flushBullet = () => {
    if (bullet.length) push(bullet.join('\n'), false);
    bullet = [];
  };
  const flushProse = () => {
    if (prose.length) push(prose.join('\n'), true);
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.test(line);
    if (!inFence && !fence) {
      const h = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*([^*]+)\*\*:?\s*$/);
      if (h) {
        flushBullet();
        flushProse();
        heading = closingHashes(h[1]);
        under = headingCategory(heading);
        last = 'prose';
        continue;
      }
      if (UNDERLINE.test(line)) continue;
      // A nested list belongs to its parent bullet: "Remove the following dependencies:" over "  - `graphql`"
      // is one entry, and "`graphql`" alone reads as a change of its own.
      const nested = last === 'bullet' && bullet.length > 0 && /^\s{2,}([-*+]|\d+[.)])\s+/.test(line);
      if (!nested && /^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) {
        flushBullet();
        bullet.push(line.replace(/^\s{0,3}([-*+]|\d+[.)])\s+/, ''));
        last = 'bullet';
        continue;
      }
      if (!line.trim()) {
        // A blank line ends a bullet unless an indented line or a code block follows.
        const next = lines[i + 1] ?? '';
        if (last === 'bullet' && bullet.length && !/^\s{2,}\S/.test(next) && !/^\s*(```|~~~)/.test(next)) {
          flushBullet();
          last = 'prose';
        }
        if (last === 'prose' && prose.length) prose.push('');
        continue;
      }
    }
    if (fence) inFence = !inFence;
    if (last === 'bullet') bullet.push(line);
    else prose.push(line);
  }
  flushBullet();
  flushProse();
  return out;
}

/** Same entry from CHANGELOG.md and the GitHub release: keep the first. */
export function dedupeItems(items: ChangeItem[]): ChangeItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    // First line only: the copy in a release body often drops the nested detail.
    const key = i.text.split('\n')[0].replace(/\(?\[?#\d+\]?(\([^)]*\))?\)?/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
