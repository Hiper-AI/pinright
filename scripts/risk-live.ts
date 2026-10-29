/**
 * Live look at the risk signals for a few packages (hits the real APIs).
 * Run: npx tsx scripts/risk-live.ts npm:vite npm:next@16.4.3 pypi:requests
 */
import { parseEcosystem } from '../src/ecosystems.js';
import { checkPackage } from '../src/verdict.js';

for (const arg of process.argv.slice(2)) {
  const [ecoRaw, spec] = arg.split(':');
  const eco = parseEcosystem(ecoRaw);
  if (!eco || !spec) continue;
  const at = spec.lastIndexOf('@');
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
  const v = await checkPackage(eco, name, version);
  const r = v.risk;
  console.log(`### ${arg} verdict=${v.report.verdict}${v.typo?.lookalikeOf ? ` lookalikeOf=${v.typo.lookalikeOf}` : ''}`);
  if (!r) {
    console.log('  (no risk report)');
    continue;
  }
  const sc = r.scorecard ? `${r.scorecard.score} ${r.scorecard.repo}${r.scorecard.failing.length ? ` failing=${r.scorecard.failing.join(',')}` : ''}` : '-';
  console.log(
    `  version=${r.version} first=${r.firstPublishedAt?.slice(0, 10)} weekly=${r.weeklyDownloads} provenance=${r.provenance} ` +
      `publisher=${r.publisher} scripts=${JSON.stringify(r.installScripts)} scorecard=${sc}`,
  );
  for (const s of r.signals) console.log(`  [${s.level}] ${s.id}: ${s.message}`);
  if (r.unknown.length) console.log(`  unknown: ${r.unknown.join('; ')}`);
}
