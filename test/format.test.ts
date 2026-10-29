import { describe, expect, it } from 'vitest';
import { securityNotice } from '../src/format.js';
import { parseLibraryId } from '../src/mapping.js';
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
    expect(text).toBe('Security check: next (npm) has no known advisories | Recommended version: 16.4.3 (latest) | License: MIT | Verified against deps.dev + osv.dev on 2026-10-29');
  });

  it('keeps any other line of an ok verdict on its own line', () => {
    const text = securityNotice({ ...base, recentMajor: { line: '16.x', since: '2026-02-01' } });
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Security check: .* \| Verified against/);
    expect(lines[1]).toMatch(/^Heads-up: next 16.x is a recent major/);
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

describe('GitHub repo ids', () => {
  it('parses ids with and without a version', () => {
    expect(parseLibraryId('/vercel/next.js')).toEqual({ owner: 'vercel', repo: 'next.js', version: undefined, base: '/vercel/next.js' });
    expect(parseLibraryId('/vercel/next.js/v15.1.8').version).toBe('v15.1.8');
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
  it('points to the nearest newer line before the newest major', () => {
    const t = securityNotice({
      ...base, package: 'org.springframework:spring-core', ecosystem: 'maven', verdict: 'vulnerable', line: '5.x', crossLineRequired: true,
      safeVersion: '7.0.10', safeVersionNearestLine: '6.2.19', nearestLine: '6.x', requested: { ...vuln, version: '5.3.20' },
    });
    expect(t).toContain('Nearest fix: 6.2.19 on 6.x, a different major line');
    expect(t).toContain('org.springframework:spring-core:6.2.19');
    expect(t).toContain('call upgrade-guide from 5.3.20 to 6.2.19');
    expect(t).toContain('Newest safe overall: 7.0.10.');
  });
});

describe('split package families', () => {
  it('langchain 1.x lists the companion packages it does not depend on', () => {
    const t = securityNotice({ ...base, package: 'langchain', ecosystem: 'pypi', safeVersion: '1.4.7', latestVersion: '1.4.7' });
    expect(t).toContain('Companion packages: langchain 1.4.7 does not depend on them');
    expect(t).toContain('langchain-text-splitters (`langchain_text_splitters`)');
    expect(t).not.toContain('langchain-core');
  });
  it('says nothing for langchain 0.x (it still pulled the splitters) or other packages', () => {
    expect(securityNotice({ ...base, package: 'langchain', ecosystem: 'pypi', safeVersion: '0.3.27' })).not.toContain('Companion');
    expect(securityNotice({ ...base, package: 'langchain-openai', ecosystem: 'pypi', safeVersion: '1.7.3' })).not.toContain('Companion');
  });
});
