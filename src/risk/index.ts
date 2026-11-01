/**
 * Risk signals for the version an agent is about to install: gathers the facts
 * (npm registry, download counts, deps.dev Scorecard), turns them into signals,
 * and renders them for the notice and the hook. Every source fails soft into
 * `unknown`; nothing here ever makes a verdict look better than it is.
 */
import { getPackage, type DepsDevVersionSummary } from '../advisories/depsdev.js';
import { isPrerelease } from '../advisories/resolve.js';
import { type Ecosystem } from '../ecosystems.js';
import { findingsFor } from '../untrusted/index.js';
import { DENY_SIGNALS, riskSignals, riskThresholds, type RiskReport, type VersionFacts } from './signals.js';
import { depsDevFacts, DOWNLOAD_ECOSYSTEMS, npmVersionFacts, weeklyDownloads } from './sources.js';

export type { RiskLevel, RiskReport, RiskSignal } from './signals.js';
export { riskThresholds } from './signals.js';

const strip = (v: string) => v.replace(/^v/, '');

/** Earlier versions of the same kind (a stable release is compared with stable ones), newest first. */
export function previousVersions(versions: DepsDevVersionSummary[], version: string, limit: number): DepsDevVersionSummary[] {
  const cur = versions.find((v) => strip(v.versionKey.version) === strip(version));
  const at = cur?.publishedAt;
  if (!at) return [];
  const pre = isPrerelease(version);
  return versions
    .filter((v) => v.publishedAt && v.publishedAt < at && (pre || !isPrerelease(v.versionKey.version)))
    .sort((a, b) => (b.publishedAt as string).localeCompare(a.publishedAt as string))
    .slice(0, limit);
}

/**
 * `agentText`: registry text of this version already judged as addressing an agent (the
 * deprecation message, from the verdict). Docs findings come from earlier get-docs and
 * upgrade-guide answers for the same version (src/untrusted).
 */
export async function assessRisk(eco: Ecosystem, name: string, version: string, now = Date.now(), agentText: string[] = []): Promise<RiskReport> {
  const t = riskThresholds();
  const unknown: string[] = [];
  const sources = new Set<string>();

  let versions: DepsDevVersionSummary[] = [];
  try {
    versions = (await getPackage(eco, name))?.versions ?? [];
  } catch {
    unknown.push('package age');
  }
  const summary = versions.find((v) => strip(v.versionKey.version) === strip(version));
  const firstPublishedAt = versions
    .map((v) => v.publishedAt)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  const earlier = previousVersions(versions, version, t.history);

  const npm = eco === 'npm';
  const [current, previous, downloads, dd] = await Promise.all([
    npm
      ? npmVersionFacts(name, version).then(
          (f) => {
            if (f) sources.add('registry.npmjs.org');
            else unknown.push('install scripts, provenance and publisher (version not in the npm registry)');
            return f;
          },
          () => {
            unknown.push('install scripts, provenance and publisher (npm registry did not answer)');
            return undefined;
          },
        )
      : Promise.resolve(undefined),
    npm
      ? Promise.all(
          earlier.map((v) =>
            npmVersionFacts(name, v.versionKey.version).then(
              (f): VersionFacts | undefined => (f ? { ...f, publishedAt: v.publishedAt } : undefined),
              () => undefined,
            ),
          ),
        ).then((list) => list.filter((f): f is VersionFacts => Boolean(f)))
      : Promise.resolve([] as VersionFacts[]),
    DOWNLOAD_ECOSYSTEMS.includes(eco)
      ? weeklyDownloads(eco, name).then(
          (n) => {
            if (n !== undefined) sources.add(npm ? 'api.npmjs.org' : 'pypistats.org');
            else unknown.push('weekly downloads (no data yet)');
            return n;
          },
          () => {
            unknown.push('weekly downloads');
            return undefined;
          },
        )
      : Promise.resolve(undefined),
    depsDevFacts(eco, name, version).catch(() => {
      unknown.push('OpenSSF Scorecard');
      return {} as Awaited<ReturnType<typeof depsDevFacts>>;
    }),
  ]);
  if (npm && earlier.length && !previous.length && current) unknown.push('earlier versions (npm registry did not answer)');
  if (dd.scorecard) sources.add('OpenSSF Scorecard via deps.dev');

  const cur: VersionFacts = {
    ...(current ?? { version }),
    publishedAt: summary?.publishedAt,
    // The registry's own field for npm; elsewhere only a positive answer from deps.dev counts.
    provenance: current ? current.provenance || dd.provenance === true : dd.provenance,
  };
  const seen = findingsFor(eco, name, version).map((f) => `${f.where} (${f.reasons.join(', ')})`);
  const facts = { current: cur, previous, firstPublishedAt, weeklyDownloads: downloads, scorecard: dd.scorecard, agentText: [...agentText, ...seen] };
  return {
    version,
    signals: riskSignals(facts, now, t),
    installScripts: cur.installScripts,
    provenance: cur.provenance,
    publisher: cur.publisher,
    firstPublishedAt,
    weeklyDownloads: downloads,
    scorecard: dd.scorecard,
    unknown,
    sources: [...sources].sort(),
  };
}

/** Lines for the security notice. Nothing when there is nothing to say. */
export function riskLines(risk: RiskReport | undefined): string[] {
  if (!risk) return [];
  const lines: string[] = [];
  if (risk.signals.length) {
    lines.push(`Supply-chain signals for ${risk.version}:`);
    for (const s of risk.signals) lines.push(`  - [${s.level}] ${s.message}`);
  }
  if (risk.unknown.length) lines.push(`Not verified: ${risk.unknown.join('; ')}.`);
  return lines;
}

export interface RiskOutcome {
  action: 'allow' | 'deny';
  problem?: string;
  warning?: string;
}

/**
 * The hook's rule, conservative on purpose. Deny only a package that is brand
 * new and runs install scripts, or a release that adds install scripts from a
 * publisher the previous releases never had; every other warn/high signal is a
 * note. PINRIGHT_HOOK_RISK: "enforce" (default), "warn" (never deny), "off".
 */
export function riskOutcome(label: string, risk: RiskReport | undefined): RiskOutcome | undefined {
  const mode = process.env.PINRIGHT_HOOK_RISK ?? 'enforce';
  if (!risk || mode === 'off') return undefined;
  const serious = risk.signals.filter((s) => s.level !== 'info');
  if (!serious.length) return undefined;
  const text = `${label}, version ${risk.version}: ${serious.map((s) => s.message).join('; ')}.`;
  if (mode !== 'warn' && serious.some((s) => DENY_SIGNALS.has(s.id))) {
    return {
      action: 'deny',
      problem: `${text} Install scripts run with your user's rights; use an established package or version, review this one by hand, or add it to PINRIGHT_ALLOW.`,
    };
  }
  return { action: 'allow', warning: text };
}
