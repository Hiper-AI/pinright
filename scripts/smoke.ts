/**
 * Live smoke test against the real APIs. Run: npx tsx scripts/smoke.ts
 * Not part of `npm test` (that one is offline).
 */
import { checkPackage } from '../src/verdict.js';
import { resolvePackage } from '../src/mapping.js';
import { securityNotice } from '../src/format.js';

async function show(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`\n=== ${label} (${Date.now() - t0} ms)\n${typeof out === 'string' ? out : JSON.stringify(out, null, 1)}`);
  } catch (err) {
    console.log(`\n=== ${label} FAILED: ${(err as Error).message}`);
  }
}

await show('map /vercel/next.js', () => resolvePackage('/vercel/next.js'));
await show('map /prisma/prisma', () => resolvePackage('/prisma/prisma'));
await show('map /psf/requests', () => resolvePackage('/psf/requests'));
await show('map /tokio-rs/tokio', () => resolvePackage('/tokio-rs/tokio'));
await show('map /websites/nextjs', () => resolvePackage('/websites/nextjs'));

await show('next@15.0.0', async () => securityNotice(...Object.values(await checkPackage('npm', 'next', '15.0.0')) as [never]));
await show('next (no version)', async () => { const v = await checkPackage('npm', 'next'); return securityNotice(v.report, v.typo); });
await show('lodash@4.17.20', async () => { const v = await checkPackage('npm', 'lodash', '4.17.20'); return securityNotice(v.report, v.typo); });
await show('reqeusts (pypi)', async () => { const v = await checkPackage('pypi', 'reqeusts'); return securityNotice(v.report, v.typo); });
await show('requests@2.31.0', async () => { const v = await checkPackage('pypi', 'requests', '2.31.0'); return securityNotice(v.report, v.typo); });
await show('tokio (cargo)', async () => { const v = await checkPackage('cargo', 'tokio'); return securityNotice(v.report, v.typo); });
await show('event-stream@3.3.6 (malware 2018)', async () => { const v = await checkPackage('npm', 'event-stream', '3.3.6'); return securityNotice(v.report, v.typo); });
