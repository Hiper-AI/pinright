/**
 * Version arithmetic for upgrade ranges. npm versions are semver; PyPI's PEP 440
 * spellings ("2.0b3", "1.0.0rc1", "0.3.27.post1") are mapped onto semver so one
 * comparison works for both. Anything that does not parse is left out of a range
 * rather than guessed into it.
 */
import semver from 'semver';

const PRE_LABEL: Record<string, string> = { a: 'alpha', alpha: 'alpha', b: 'beta', beta: 'beta', c: 'rc', rc: 'rc', pre: 'pre', preview: 'preview', dev: 'dev', canary: 'canary', next: 'next' };

/** "2.0b3" -> "2.0.0-beta.3", "v1.2" -> "1.2.0", "1.0.0-rc.1" -> "1.0.0-rc.1". Undefined when it is not a version. */
export function toSemver(version: string): string | undefined {
  const s = version.trim().replace(/^v(?=\d)/i, '');
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)?(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview|dev|canary|next)(?:[-_.]?(\d+))?)?(?:[-_.]?(?:post|r|rev)[-_.]?\d*)?((?:[-+.][0-9A-Za-z.-]+)?)$/i);
  if (!m) return undefined;
  const [, maj, min, pat, label, num, rest] = m;
  const base = `${Number(maj)}.${Number(min ?? 0)}.${Number(pat ?? 0)}`;
  if (label) return `${base}-${PRE_LABEL[label.toLowerCase()]}.${Number(num || 0)}`;
  // Leftover semver prerelease/build ("-canary.31", "+build"): let semver judge it.
  const full = `${base}${rest ?? ''}`;
  return semver.valid(full) ?? (rest ? undefined : base);
}

export function compareVersions(a: string, b: string): number | undefined {
  const x = toSemver(a);
  const y = toSemver(b);
  if (!x || !y) return undefined;
  return semver.compare(x, y);
}

export function isPrereleaseVersion(v: string): boolean {
  const s = toSemver(v);
  return Boolean(s && semver.prerelease(s));
}

export function majorOf(v: string): number | undefined {
  const s = toSemver(v);
  return s ? semver.major(s) : undefined;
}

/** "3" for 3.2.1, "0.28" for 0.28.1: the unit inside which no API break is expected. */
export function lineOf(v: string): string | undefined {
  const s = toSemver(v);
  if (!s) return undefined;
  return semver.major(s) === 0 ? `0.${semver.minor(s)}` : String(semver.major(s));
}

/** True when moving from -> to leaves the release line, so breaking changes are expected. */
export function crossesLine(from: string, to: string): boolean {
  const a = lineOf(from);
  const b = lineOf(to);
  return Boolean(a && b && a !== b);
}

/** Majors a migration guide could be written for: (major(from), major(to)]; pre-1.0 minors count too. */
export function majorsInRange(from: string, to: string): number[] {
  const a = majorOf(from);
  const b = majorOf(to);
  if (a === undefined || b === undefined || b < a) return [];
  const out: number[] = [];
  for (let m = a + 1; m <= b; m++) out.push(m);
  return out;
}

/**
 * Is `v` in (from, to]? A prerelease only counts when it leads up to a new
 * line inside the range (2.0.0b1 when going 1.10 -> 2.x): that is where breaking
 * notes are written; nightly and canary builds of patches are noise.
 */
export function inUpgradeRange(v: string, from: string, to: string): boolean {
  const s = toSemver(v);
  const f = toSemver(from);
  const t = toSemver(to);
  if (!s || !f || !t) return false;
  if (!(semver.gt(s, f) && semver.lte(s, t))) return false;
  if (!semver.prerelease(s)) return true;
  if (semver.prerelease(t)) return true;
  const p = semver.parse(s) as semver.SemVer;
  return p.patch === 0 && (p.minor === 0 || p.major === 0) && lineOf(s) !== lineOf(f);
}

/** The first version-looking token in a heading: "## [1.2.3] - 2024-01-01", "v2.0b3 (2023-05-01)", "langchain==1.0.0". */
export function versionInHeading(heading: string): string | undefined {
  const m = heading.match(/(?:^|[\s[(@=/#:-])v?(\d+\.\d+(?:\.\d+){0,2}(?:-?(?:a|alpha|b|beta|c|rc|pre|preview|dev|canary|next)[-.]?\d*|-[0-9A-Za-z.]+)?)(?=$|[\s\])(,:;*_`/]|\.(?!\d))/i);
  return m?.[1];
}

/**
 * The version a release tag stands for, when the tag belongs to this package:
 * "v1.2.3", "1.2.3", "next@1.2.3", "@scope/pkg@1.2.3", "langchain==1.0.0",
 * "typescript/v7.0.2", "pkg-v1.2.3". Tags of sibling packages in a monorepo
 * ("langchain-core==1.0.0") return undefined.
 */
export function versionFromTag(tag: string, name: string): string | undefined {
  const m = tag.match(/^(.*?)v?(\d+\.\d+.*)$/);
  if (!m) return undefined;
  const prefix = m[1].replace(/(==|@|\/|-|_)$/, '').replace(/[-_/]v$/, '').toLowerCase();
  if (prefix) {
    const short = name.replace(/^@[^/]+\//, '').toLowerCase();
    const names = new Set([name.toLowerCase(), short, short.replace(/_/g, '-'), short.replace(/-/g, '_')]);
    if (!names.has(prefix)) return undefined;
  }
  return toSemver(m[2]) ? m[2] : undefined;
}

/**
 * A version the user typed, against the published ones: an exact version when it
 * exists ("2.0" is a real pydantic release), else the newest one satisfying it as a
 * range ("5.x", "2", "1.10.x"), stable first.
 */
export function resolveVersionSpec(spec: string, versions: string[]): string | undefined {
  const r = spec.trim().replace(/^v(?=\d)/, '');
  const exact = versions.find((v) => v.replace(/^v/, '') === r);
  if (exact) return exact;
  if (!semver.validRange(r, { loose: true })) return undefined;
  const ok = versions
    .map((v) => ({ v, s: toSemver(v) }))
    .filter((x): x is { v: string; s: string } => Boolean(x.s) && semver.satisfies(x.s as string, r, { loose: true }))
    .sort((a, b) => semver.rcompare(a.s, b.s));
  return (ok.find((x) => !semver.prerelease(x.s)) ?? ok[0])?.v;
}
