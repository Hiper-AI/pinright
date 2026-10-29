import { describe, expect, it } from 'vitest';
import { securityNotice } from '../src/format.js';
import { parseLibraryId, withVersion } from '../src/context7.js';
import { installCommand, parseEcosystem } from '../src/ecosystems.js';
import type { PackageReport } from '../src/advisories/resolve.js';

const base: PackageReport = {
  package: 'next',
  ecosystem: 'npm',
  verdict: 'ok',
  latestVersion: '16.4.3',
  safeVersion: '16.4.3',
  safeVersionLicenses: ['MIT'],
  checkedAt: '2026-10-29T00:00:00.000Z',
  sources: ['deps.dev', 'osv.dev'],
};

describe('securityNotice', () => {
  it('starts with SECURITY NOTICE and the upgrade command for a vulnerable pin', () => {
    const text = securityNotice({
      ...base,
      verdict: 'vulnerable',
      requested: { version: '15.0.0', verdict: 'vulnerable', advisories: [{ id: 'GHSA-f82v-jwr5-mffw', aliases: ['CVE-2025-29927'], title: 'Authorization Bypass', severity: 'CRITICAL', fixedIn: ['15.2.3'], url: '' }] },
    });
    expect(text.startsWith('SECURITY NOTICE: next (npm)@15.0.0 has 1 known advisory.')).toBe(true);
    expect(text).toContain('CVE-2025-29927');
    expect(text).toContain('npm install next@16.4.3');
    expect(text).toContain('Verified against deps.dev + osv.dev on 2026-10-29');
  });

  it('reads as a plain check when everything is fine', () => {
    const text = securityNotice(base);
    expect(text).toMatch(/^Security check: next \(npm\) has no known advisories/);
    expect(text).not.toContain('Upgrade:');
  });

  it('never says ok when a source was down', () => {
    const text = securityNotice({ ...base, verdict: 'unknown', reason: 'deps.dev did not answer', safeVersion: undefined });
    expect(text).toMatch(/^NOTICE: no security verdict/);
    expect(text).toContain('unverified');
  });

  it('names the lookalike for a typosquat', () => {
    const text = securityNotice({ ...base, package: 'reqeusts', ecosystem: 'pypi', verdict: 'possible-typosquat', safeVersion: undefined }, { existsInRegistry: false, lookalikeOf: 'requests', distance: 1 });
    expect(text).toContain('"requests"');
    expect(text).toContain('does not exist in the registry');
  });
});

describe('context7 ids', () => {
  it('parses ids with and without a version', () => {
    expect(parseLibraryId('/vercel/next.js')).toEqual({ owner: 'vercel', repo: 'next.js', version: undefined, base: '/vercel/next.js' });
    expect(parseLibraryId('/vercel/next.js/v15.1.8').version).toBe('v15.1.8');
    expect(withVersion('/vercel/next.js/v14', 'v15.1.8')).toBe('/vercel/next.js/v15.1.8');
    expect(() => parseLibraryId('next')).toThrow();
  });
});

describe('ecosystems', () => {
  it('accepts the names people type', () => {
    expect(parseEcosystem('python')).toBe('pypi');
    expect(parseEcosystem('Rust')).toBe('cargo');
    expect(parseEcosystem('node')).toBe('npm');
    expect(parseEcosystem('swift')).toBeUndefined();
  });
  it('writes the install command per ecosystem', () => {
    expect(installCommand('pypi', 'requests', '2.34.2')).toBe('pip install "requests==2.34.2"');
    expect(installCommand('go', 'github.com/gin-gonic/gin', 'v1.10.0')).toBe('go get github.com/gin-gonic/gin@v1.10.0');
  });
});

describe('securityNotice with release lines', () => {
  const vuln = { version: '3.9.0', verdict: 'vulnerable' as const, advisories: [{ id: 'GHSA-x', aliases: [], url: '' }] };
  it('puts the same-line upgrade first and the major upgrade as a separate warning', () => {
    const t = securityNotice({ ...base, package: 'zod', verdict: 'vulnerable', line: '3.x', safeVersionSameLine: '3.25.80', safeVersion: '4.6.7', requested: vuln });
    expect(t).toContain('Recommended within 3.x: 3.25.80');
    expect(t).toContain('npm install zod@3.25.80');
    expect(t).toContain('Newest safe overall: 4.6.7 (a different major');
    expect(t).toContain('call upgrade-guide from 3.9.0 to 4.6.7');
  });
  it('says plainly when the fix needs a new major', () => {
    const t = securityNotice({ ...base, package: 'jsonwebtoken', verdict: 'vulnerable', line: '8.x', crossLineRequired: true, safeVersion: '9.0.3', requested: { ...vuln, version: '8.5.1' } });
    expect(t).toContain('No 8.x release is free of known advisories. The fix needs 9.0.3, a different major');
    expect(t).toContain('call upgrade-guide from 8.5.1 to 9.0.3');
  });
});
