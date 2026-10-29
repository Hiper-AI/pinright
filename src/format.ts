/**
 * What the agent reads. Plain text, worst news first, and the sources with a date,
 * so the model cannot mistake a cached verdict for a fresh one.
 */
import { installCommand } from './ecosystems.js';
import { releaseLine, type PackageReport } from './advisories/resolve.js';
import { type TyposquatReport } from './typosquat.js';

export function securityNotice(report: PackageReport, typo?: TyposquatReport): string {
  const lines: string[] = [];
  const pkg = `${report.package} (${report.ecosystem})`;
  const req = report.requested;

  switch (report.verdict) {
    case 'malicious':
      lines.push(`SECURITY NOTICE: ${pkg}@${req?.version} is flagged as MALWARE. Do not install or document it.`);
      break;
    case 'vulnerable':
      if (req) {
        lines.push(`SECURITY NOTICE: ${pkg}@${req.version} has ${req.advisories.length} known advisor${req.advisories.length === 1 ? 'y' : 'ies'}.`);
      } else {
        lines.push(`SECURITY NOTICE: no recent stable version of ${pkg} is free of known advisories.`);
      }
      break;
    case 'deprecated':
      lines.push(`NOTICE: ${pkg}@${req?.version} is deprecated by its maintainers${req?.deprecatedReason ? `: ${req.deprecatedReason}` : '.'}`);
      break;
    case 'possible-typosquat':
      lines.push(`SECURITY NOTICE: "${report.package}" looks like a typo of the popular package "${typo?.lookalikeOf}"${typo?.existsInRegistry === false ? ' and does not exist in the registry' : ''}. Confirm the name before installing.`);
      break;
    case 'unknown-package':
      if (req && report.latestVersion) {
        lines.push(`SECURITY NOTICE: version ${req.version} of ${pkg} is not in the registry (never published, or removed; removed versions are often the malicious ones). Do not use it.`);
      } else {
        lines.push(`NOTICE: ${pkg} could not be found in deps.dev${typo?.existsInRegistry === false ? ' nor in the official registry' : ''}. ${report.reason ?? ''}`.trim());
      }
      break;
    case 'unknown':
      lines.push(`NOTICE: no security verdict for ${pkg}: ${report.reason ?? 'a data source did not answer'}. Treat as unverified.`);
      break;
    case 'ok':
      lines.push(`Security check: ${pkg}${req ? `@${req.version}` : ''} has no known advisories.`);
      break;
  }

  if (req && req.advisories.length) {
    for (const a of req.advisories.slice(0, 8)) {
      const alias = a.aliases.find((x) => x.startsWith('CVE-'));
      const sev = a.severity ?? (a.cvss3Score != null ? `CVSS ${a.cvss3Score}` : undefined);
      const fixed = a.fixedIn?.length ? ` fixed in ${a.fixedIn.join(', ')}` : '';
      lines.push(`  - ${a.id}${alias ? ` (${alias})` : ''}${sev ? ` [${sev}]` : ''}: ${a.title ?? ''}${fixed}`);
    }
    if (req.advisories.length > 8) lines.push(`  - ... and ${req.advisories.length - 8} more`);
  }

  const sameLine = report.safeVersionSameLine;
  const cmd = (v: string) => installCommand(report.ecosystem, report.package, v);
  if (req && report.line && sameLine && sameLine !== req.version) {
    lines.push(`Recommended within ${report.line}: ${sameLine} (same release line, no API break expected). Upgrade: ${cmd(sameLine)}`);
    if (report.safeVersion && report.safeVersion !== sameLine) {
      lines.push(
        `Newest safe overall: ${report.safeVersion} (a different major: before switching, call upgrade-guide from ${req.version} to ${report.safeVersion} for what changes).`,
      );
    }
  } else if (req && report.line && report.crossLineRequired && report.safeVersion) {
    lines.push(
      `No ${report.line} release is free of known advisories. The fix needs ${report.safeVersion}, a different major: ` +
        `expect breaking changes, read the migration guide. Upgrade: ${cmd(report.safeVersion)}`,
    );
    lines.push(`Before rewriting code or config for it, call upgrade-guide from ${req.version} to ${report.safeVersion}.`);
  } else if (report.safeVersion) {
    const isUpgrade = req && req.version !== report.safeVersion;
    lines.push(
      `Recommended version: ${report.safeVersion}` +
        (report.latestVersion && report.latestVersion !== report.safeVersion
          ? ` (latest ${report.latestVersion} is inside the cooldown window, a pre-release or has an advisory)`
          : ' (latest)') +
        (isUpgrade ? `. Upgrade: ${cmd(report.safeVersion)}` : '.'),
    );
  }
  if (report.safeVersion && report.safeVersionLicenses?.length) lines.push(`License: ${report.safeVersionLicenses.join(' / ')}`);
  const le = report.leastExposed;
  if (!report.safeVersion && le && (!req || le.version !== req.version)) {
    lines.push(
      `No version is free of known advisories. Least exposed: ${le.version} (${le.advisories} advisor${le.advisories === 1 ? 'y' : 'ies'}, worst ${le.maxSeverity ?? 'unrated'}). ` +
        `Install: ${cmd(le.version)}`,
    );
  }
  const recommended = sameLine && req && sameLine !== req.version ? sameLine : report.safeVersion;
  if (report.recentMajor && recommended && releaseLine(recommended) === report.recentMajor.line) {
    lines.push(
      `Heads-up: ${report.package} ${report.recentMajor.line} is a recent major (first release ${report.recentMajor.since}). ` +
        `Its APIs and configuration may differ from what you know; read query-docs for ${recommended} before writing code or config for it.`,
    );
  }

  lines.push(`Verified against ${report.sources.join(' + ')} on ${report.checkedAt.slice(0, 10)}.`);
  if (report.verdict === 'ok') {
    // Nothing to warn about: the routine lines fit on one; anything else keeps its own line.
    const routine = /^(Security check:|Recommended version:|License:|Verified against )/;
    const one = lines.filter((l) => routine.test(l)).map((l) => l.replace(/\.$/, '')).join(' | ');
    return [one, ...lines.filter((l) => !routine.test(l))].join('\n');
  }
  return lines.join('\n');
}
