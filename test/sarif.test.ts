/**
 * SARIF output: the builder on a small hand-made audit (no network), checked
 * against the official SARIF 2.1.0 schema (test/fixtures/sarif-schema-2.1.0.json,
 * OASIS errata01) and GitHub's documented requirements and limits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import type { ActionsAudit } from '../src/actions/check.js';
import { parseUses } from '../src/actions/workflow.js';
import { cvss3BaseScore } from '../src/advisories/cvss.js';
import { auditExitCode, parseFailOn, sarifRoot, type AuditRun } from '../src/auditRun.js';
import { buildSarif, levelOf, MAX_RESULTS, manifestOf, securitySeverity, type SarifInput } from '../src/sarif/build.js';
import { annotations, summaryMarkdown } from '../src/sarif/summary.js';
import { resolvePolicy } from '../src/teamConfig.js';
import type { TreeAudit } from '../src/tree/audit.js';
import { parseFile } from '../src/tree/lockfiles.js';
import { toFindings } from '../src/tree/supply.js';

const FIX = path.join(__dirname, 'fixtures', 'action');
const ROOT = path.resolve(__dirname, 'virtual-repo');
const files: Record<string, string> = {
  [path.join(ROOT, 'app', 'package.json')]: fs.readFileSync(path.join(FIX, 'package.json.fixture'), 'utf8'),
  [path.join(ROOT, 'app', 'package-lock.json')]: fs.readFileSync(path.join(FIX, 'package-lock.json.fixture'), 'utf8'),
  [path.join(ROOT, '.github', 'workflows', 'ci.yml')]: fs.readFileSync(path.join(FIX, 'workflow.yml.fixture'), 'utf8'),
};
const LOCK = path.join(ROOT, 'app', 'package-lock.json');
const WF = path.join(ROOT, '.github', 'workflows', 'ci.yml');

const adv = (id: string, cve: string, title: string, severity: string, cvss3Score?: number) => ({
  id,
  aliases: [cve],
  title,
  severity,
  cvss3Score,
  url: `https://osv.dev/vulnerability/${id}`,
});

function treeAudit(): TreeAudit {
  return {
    ecosystem: 'npm',
    file: LOCK,
    source: 'lockfile',
    packages: 4,
    vulnerablePackages: 2,
    alerts: 3,
    bySeverity: { critical: 1, high: 1, moderate: 1, low: 0, unknown: 0 },
    malicious: 0,
    findings: [
      {
        name: 'minimist', version: '0.0.8', direct: false, path: ['mkdirp', 'minimist'], malicious: false, severity: 'CRITICAL', fixedVersion: '0.2.4',
        advisories: [adv('GHSA-xvch-5gv4-984h', 'CVE-2021-44906', 'Prototype Pollution in minimist', 'CRITICAL', 9.8)],
      },
      {
        name: 'lodash', version: '4.17.20', direct: true, malicious: false, severity: 'HIGH', fixedVersion: '4.17.21',
        advisories: [
          adv('GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337', 'Command Injection in lodash.', 'HIGH', 7.2),
          adv('GHSA-29mw-wpgm-hmr9', 'CVE-2020-28500', 'Regular Expression Denial of Service (ReDoS) in lodash', 'MODERATE'),
        ],
      },
    ],
    remediation: [
      { target: 'lodash', from: '4.17.20', to: '4.17.21', kind: 'upgrade-direct', command: 'npm install lodash@4.17.21', clears: ['lodash@4.17.20'] },
      { target: 'mkdirp', from: '0.5.1', to: '0.5.6', kind: 'upgrade-parent', command: 'npm install mkdirp@0.5.6', clears: ['minimist@0.0.8'] },
    ],
    notes: [],
    checkedAt: '2026-10-29T00:00:00.000Z',
  };
}

function actionsAudit(): ActionsAudit {
  const uses = parseUses(files[WF], WF);
  const [checkout, changed, setupNode] = uses;
  const base = { exists: true, advisories: [], checkedAt: '2026-10-29T00:00:00.000Z' };
  return {
    files: [WF],
    actions: 3,
    vulnerable: 1,
    unpinned: 2,
    unverified: 0,
    missing: 0,
    bySeverity: { critical: 0, high: 1, moderate: 0, low: 0, unknown: 0 },
    malicious: 0,
    findings: [
      {
        ...base, use: changed, name: 'tj-actions/changed-files', pinned: false, version: 'v35.9.3', fixedIn: '46.0.1',
        advisories: [adv('GHSA-mrrh-fwg8-r2c3', 'CVE-2025-30066', 'tj-actions changed-files allows remote attackers to discover secrets by reading actions logs.', 'HIGH', 8.6)],
        upgradeTo: 'tj-actions/changed-files@9426d40962ed5378910ee2e21d5f8c6fcbf2dd96 # v47.0.6',
        locations: [`${WF}:${changed.line}`],
      },
      {
        ...base, use: checkout, name: 'actions/checkout', pinned: false, version: 'v4.4.0',
        pinTo: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
        locations: [`${WF}:${checkout.line}`],
      },
      { ...base, use: setupNode, name: 'actions/setup-node', pinned: true, version: 'v7.1.0', locations: [`${WF}:${setupNode.line}`] },
    ],
    notes: [],
    checkedAt: '2026-10-29T00:00:00.000Z',
  };
}

function input(over: Partial<SarifInput> = {}, read = (f: string) => files[f]): SarifInput {
  const tree = parseFile(LOCK, files[LOCK], { 'package.json': files[path.join(ROOT, 'app', 'package.json')] });
  return {
    root: ROOT,
    toolVersion: '0.2.0',
    trees: [
      {
        audit: treeAudit(),
        packages: tree.packages,
        supply: [
          { kind: 'typosquat', name: 'expresss', version: '0.0.0', blocking: true, level: 'error', lookalikeOf: 'express', message: 'expresss looks like a typosquat of "express".' },
          { kind: 'deprecated', name: 'mkdirp', version: '0.5.1', blocking: false, level: 'note', message: 'mkdirp@0.5.1 is deprecated.' },
          { kind: 'risk', signal: 'install-script-new-package', name: 'lodash', version: '4.17.20', blocking: true, level: 'error', message: 'lodash@4.17.20: new package with install scripts' },
        ],
        policy: [
          { kind: 'deny', name: 'minimist', version: '0.0.8', text: 'minimist: denied by the project policy (.safectx.json): use yargs.' },
          { kind: 'note', text: 'Licenses checked for the first 60 direct dependencies only.' },
        ],
      },
    ],
    actions: actionsAudit(),
    notes: ['a note for the run'],
    read,
    ...over,
  };
}

/** The file URI of the root differs per OS; everything else must be byte-stable. */
function portable(log: ReturnType<typeof buildSarif>) {
  const copy = JSON.parse(JSON.stringify(log));
  copy.runs[0].originalUriBaseIds['%SRCROOT%'].uri = 'file:///repo/';
  return copy;
}

const results = (log: ReturnType<typeof buildSarif>) => log.runs[0].results as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const byRule = (log: ReturnType<typeof buildSarif>, id: string) => results(log).filter((r) => r.ruleId === id);

describe('buildSarif', () => {
  const log = buildSarif(input());

  it('matches the snapshot', () => {
    expect(portable(log)).toMatchSnapshot();
  });

  it('is valid against the official SARIF 2.1.0 schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sarif-schema-2.1.0.json'), 'utf8'));
    // Formats ("uri", "date-time") are not checked by ajv without ajv-formats; URIs are checked below.
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    const ok = validate(log);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    // The validator does bite: a level SARIF does not define is rejected.
    const bad = JSON.parse(JSON.stringify(log));
    bad.runs[0].results[0].level = 'critical';
    expect(validate(bad)).toBe(false);
  });

  it('meets GitHub code scanning requirements', () => {
    const run = log.runs[0];
    expect(log.version).toBe('2.1.0');
    expect(run.tool.driver.name).toBe('safectx');
    for (const r of run.tool.driver.rules) {
      expect(r.shortDescription.text.length).toBeGreaterThan(0);
      expect(r.fullDescription.text.length).toBeLessThanOrEqual(1024);
      expect(r.help.text.length).toBeGreaterThan(0);
      expect(r.properties.tags.length).toBeLessThanOrEqual(10);
      const s = r.properties['security-severity'];
      if (s !== undefined) {
        expect(typeof s).toBe('string');
        expect(Number(s)).toBeGreaterThan(0);
        expect(Number(s)).toBeLessThanOrEqual(10);
      }
    }
    for (const r of results(log)) {
      expect(r.message.text.length).toBeGreaterThan(0);
      expect(r.partialFingerprints.primaryLocationLineHash).toMatch(/^[0-9a-f]{32}$/);
      const loc = r.locations[0].physicalLocation;
      expect(loc.region.startLine).toBeGreaterThanOrEqual(1);
      expect(loc.artifactLocation.uri).not.toMatch(/^[a-z]+:|^\/|\\|\.\.\//i); // relative, forward slashes, inside the repo
      expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
    }
  });

  it('has one rule per advisory and per finding kind', () => {
    const ids = log.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ids).toEqual([
      'GHSA-29mw-wpgm-hmr9', 'GHSA-35jh-r3h4-6jhm', 'GHSA-mrrh-fwg8-r2c3', 'GHSA-xvch-5gv4-984h',
      'safectx/action-unpinned', 'safectx/deprecated', 'safectx/policy-deny', 'safectx/risk/install-script-new-package', 'safectx/typosquat',
    ]);
    const crit = log.runs[0].tool.driver.rules.find((r: { id: string }) => r.id === 'GHSA-xvch-5gv4-984h');
    expect(crit.properties['security-severity']).toBe('9.8');
    expect(crit.shortDescription.text).toBe('CVE-2021-44906: Prototype Pollution in minimist');
    expect(crit.helpUri).toBe('https://github.com/advisories/GHSA-xvch-5gv4-984h');
    expect(crit.properties.tags).toContain('CVE-2021-44906');
  });

  it('puts a direct dependency on its package.json line, with the lockfile entry as related', () => {
    const [r] = byRule(log, 'GHSA-35jh-r3h4-6jhm');
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe('app/package.json');
    expect(r.locations[0].physicalLocation.region).toEqual({ startLine: 8, startColumn: 6, endColumn: 12 });
    expect(r.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe('app/package-lock.json');
    expect(r.relatedLocations[0].physicalLocation.region.startLine).toBe(21);
    expect(r.level).toBe('error');
    expect(r.message.text).toBe(
      'lodash@4.17.20 (direct dependency) is affected by GHSA-35jh-r3h4-6jhm (CVE-2021-23337): Command Injection in lodash. Severity: high. Fix: upgrade to 4.17.21: npm install lodash@4.17.21',
    );
  });

  it('puts a transitive dependency on its lockfile entry, with the parent declaration as related', () => {
    const [r] = byRule(log, 'GHSA-xvch-5gv4-984h');
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe('app/package-lock.json');
    expect(r.locations[0].physicalLocation.region.startLine).toBe(26);
    expect(r.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe('app/package.json');
    expect(r.relatedLocations[0].physicalLocation.region.startLine).toBe(9);
    expect(r.message.text).toContain('(via mkdirp > minimist)');
    expect(r.message.text).toContain('Fix: upgrade mkdirp from 0.5.1 to 0.5.6');
  });

  it('reports typosquats, policy denials, risk signals and Actions', () => {
    expect(byRule(log, 'safectx/typosquat')[0].locations[0].physicalLocation.region.startLine).toBe(7);
    expect(byRule(log, 'safectx/policy-deny')[0].level).toBe('error');
    expect(byRule(log, 'safectx/risk/install-script-new-package')[0].level).toBe('error');
    const pin = byRule(log, 'safectx/action-unpinned');
    expect(pin).toHaveLength(1); // the SHA-pinned setup-node is not reported
    expect(pin[0].locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: '.github/workflows/ci.yml', uriBaseId: '%SRCROOT%' },
      region: { startLine: 7, startColumn: 15, endColumn: 34 },
    });
    const tj = byRule(log, 'GHSA-mrrh-fwg8-r2c3')[0];
    expect(tj.message.text).toContain('Use: uses: tj-actions/changed-files@9426d40962ed5378910ee2e21d5f8c6fcbf2dd96 # v47.0.6');
    expect(tj.message.text).not.toContain('..');
  });

  it('keeps fingerprints when lines move, and changes them per package', () => {
    const pj = path.join(ROOT, 'app', 'package.json');
    const shifted = { ...files, [pj]: files[pj].replace('"private": true,', '"private": true,\n  "license": "MIT",') };
    const moved = buildSarif(input({}, (f) => shifted[f]));
    const fp = (l: ReturnType<typeof buildSarif>, id: string) => byRule(l, id)[0].partialFingerprints.primaryLocationLineHash;
    expect(byRule(moved, 'GHSA-35jh-r3h4-6jhm')[0].locations[0].physicalLocation.region.startLine).toBe(9);
    expect(fp(moved, 'GHSA-35jh-r3h4-6jhm')).toBe(fp(log, 'GHSA-35jh-r3h4-6jhm'));
    expect(fp(log, 'GHSA-35jh-r3h4-6jhm')).not.toBe(fp(log, 'GHSA-29mw-wpgm-hmr9'));
  });

  it('falls back to the top of a dependency file it cannot read', () => {
    const blind = buildSarif(input({}, () => undefined));
    for (const r of results(blind)) {
      const loc = r.locations[0].physicalLocation;
      // Actions findings know their line from the workflow parser; the rest falls back to line 1.
      expect(loc.region.startLine).toBe(loc.artifactLocation.uri.endsWith('ci.yml') ? r.ruleId === 'safectx/action-unpinned' ? 7 : 9 : 1);
    }
  });

  it(`keeps the ${MAX_RESULTS} most severe results`, () => {
    const many = treeAudit();
    many.findings = Array.from({ length: MAX_RESULTS + 10 }, (_, i) => ({
      name: `pkg${i}`, version: '1.0.0', malicious: false,
      advisories: [adv(`GHSA-${i}`, `CVE-${i}`, 't', i < 10 ? 'CRITICAL' : 'LOW')],
    }));
    const big = buildSarif(input({ trees: [{ audit: many }], actions: undefined }));
    expect(results(big)).toHaveLength(MAX_RESULTS);
    expect(results(big).filter((r) => r.level === 'error')).toHaveLength(10);
    expect(big.runs[0].invocations[0].toolExecutionNotifications.at(-1).message.text).toContain(`${MAX_RESULTS} most severe`);
  });

  it('reports malware as one result with every id', () => {
    const mal = treeAudit();
    mal.findings = [{ name: 'evil', version: '1.0.0', malicious: true, advisories: [adv('MAL-2026-1', 'CVE-x', 'Malicious code in evil', 'CRITICAL')] }];
    const r = results(buildSarif(input({ trees: [{ audit: mal }], actions: undefined })));
    expect(r.map((x) => x.ruleId)).toEqual(['safectx/malware']);
    expect(r[0].message.text).toContain('MAL-2026-1');
  });
});

describe('severity', () => {
  it('scores CVSS v3 vectors', () => {
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(cvss3BaseScore('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N')).toBe(5.5);
    expect(cvss3BaseScore('CVSS:3.0/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N')).toBe(4.2);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeUndefined();
  });

  it('maps to GitHub levels and buckets', () => {
    expect(securitySeverity({ severity: 'HIGH' })).toBe(8);
    expect(securitySeverity({ severity: 'LOW', cvss3Score: 9.1 })).toBe(9.1);
    expect(securitySeverity({})).toBeUndefined();
    expect(levelOf(9.8)).toBe('error');
    expect(levelOf(5)).toBe('warning');
    expect(levelOf(2)).toBe('note');
    expect(levelOf(undefined)).toBe('warning');
  });

  it('finds the manifest next to a lockfile', () => {
    const has = (f: string) => /package\.json$|build\.gradle$/.test(f);
    expect(manifestOf(path.join('a', 'yarn.lock'), has)).toBe(path.join('a', 'package.json'));
    expect(manifestOf(path.join('a', 'gradle.lockfile'), has)).toBe(path.join('a', 'build.gradle'));
    expect(manifestOf(path.join('a', 'requirements.txt'), has)).toBeUndefined();
  });
});

describe('summary and annotations', () => {
  const log = buildSarif(input());

  it('writes a Markdown table', () => {
    const md = summaryMarkdown(log, { exitCode: 1, failOn: 'high', sarifFile: 'results.sarif', uploaded: true });
    expect(md).toContain('### safectx audit failed');
    expect(md).toContain('| 1 | 5 | 2 | 0 | 0 | 1 |');
    expect(md).toContain('| critical | `GHSA-xvch-5gv4-984h` | `app/package-lock.json:26` |');
  });

  it('escapes workflow commands', () => {
    const lines = annotations(log);
    expect(lines[0]).toMatch(/^::error file=app\/package-lock.json,line=26,col=\d+,endColumn=\d+,title=safectx GHSA-xvch-5gv4-984h::/);
    expect(lines.every((l) => !/[\r\n]/.test(l))).toBe(true);
    const tricky = buildSarif(input({ trees: [{ audit: { ...treeAudit(), findings: [] }, supply: [{ kind: 'deprecated', name: 'lodash', version: '1', blocking: false, level: 'note', message: 'a\nb: 100%' }] }], actions: undefined }));
    expect(annotations(tricky)[0]).toMatch(/::a%0Ab: 100%25$/);
  });
});

describe('supply-chain findings', () => {
  const pkg = { name: 'expresss', version: '0.0.0', direct: true };
  const report = (over: object) => ({ package: 'x', ecosystem: 'npm' as const, verdict: 'ok' as const, checkedAt: '', sources: ['deps.dev', 'osv.dev'], ...over });

  it('blocks typosquats and the install-script signals the hook denies', () => {
    const f = toFindings(pkg, { report: report({ verdict: 'possible-typosquat', reason: '1 edit away from "express"' }), typo: { lookalikeOf: 'express' } });
    expect(f).toMatchObject([{ kind: 'typosquat', blocking: true, level: 'error', lookalikeOf: 'express' }]);
    const risk = toFindings(pkg, {
      report: report({}),
      risk: { version: '0.0.0', unknown: [], sources: [], signals: [
        { id: 'install-script-new-package', level: 'high', message: 'new package with install scripts' },
        { id: 'young-low-downloads', level: 'warn', message: 'young' },
        { id: 'install-script', level: 'info', message: 'runs scripts' },
      ] },
    });
    expect(risk.map((x) => [x.signal, x.blocking, x.level])).toEqual([
      ['install-script-new-package', true, 'error'],
      ['young-low-downloads', false, 'note'],
    ]);
  });

  it('reports unknown packages, unpublished versions and deprecation without blocking', () => {
    expect(toFindings(pkg, { report: report({ verdict: 'unknown-package' }) })).toMatchObject([{ kind: 'unknown-package', blocking: false }]);
    const gone = toFindings(pkg, { report: report({ verdict: 'unknown-package', latestVersion: '1.0.0', requested: { version: '0.0.0', verdict: 'unknown-package', advisories: [] } }) });
    expect(gone).toMatchObject([{ kind: 'unpublished-version', blocking: false, level: 'warning' }]);
    expect(gone[0].message).toContain('latest is 1.0.0');
    const dep = toFindings(pkg, { report: report({ requested: { version: '0.0.0', verdict: 'deprecated', isDeprecated: true, deprecatedReason: 'use y.', advisories: [] } }) });
    expect(dep[0].message).toBe('expresss@0.0.0 is deprecated: use y.');
  });
});

describe('exit code', () => {
  const run = (over: Partial<AuditRun['files'][number]> = {}, extra: Partial<AuditRun> = {}): AuditRun => ({
    target: ROOT,
    policy: resolvePolicy(undefined, {}),
    notes: [],
    files: [{ tree: parseFile(LOCK, files[LOCK]), audit: { ...treeAudit(), bySeverity: { critical: 0, high: 0, moderate: 1, low: 0, unknown: 0 } }, packages: [], policy: [], supply: [], ...over }],
    ...extra,
  });

  it('follows --fail-on for advisories', () => {
    expect(auditExitCode(run(), 'high')).toBe(0);
    expect(auditExitCode(run(), 'moderate')).toBe(1);
    expect(auditExitCode(run(), 'none')).toBe(0);
  });

  it('fails on blocking supply findings, policy denials and a broken policy file', () => {
    const typo = { kind: 'typosquat' as const, name: 'a', version: '1', blocking: true, level: 'error' as const, message: '' };
    expect(auditExitCode(run({ supply: [typo] }), 'critical')).toBe(1);
    expect(auditExitCode(run({ supply: [{ ...typo, blocking: false }] }), 'critical')).toBe(0);
    expect(auditExitCode(run({ policy: [{ kind: 'deny', name: 'a', text: '' }] }), 'critical')).toBe(1);
    expect(auditExitCode(run({ policy: [{ kind: 'note', text: '' }] }), 'critical')).toBe(0);
    expect(auditExitCode(run({}, { policyError: 'bad json' }), 'none')).toBe(1);
  });

  it('resolves the SARIF root: workspace, then git repository, then the audited directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-root-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'app'));
    fs.mkdirSync(path.join(tmp, 'loose'));
    const saved = process.env.GITHUB_WORKSPACE;
    try {
      delete process.env.GITHUB_WORKSPACE;
      expect(sarifRoot(path.join(repo, 'app'))).toBe(repo);
      expect(sarifRoot(path.join(tmp, 'loose'))).toBe(path.join(tmp, 'loose'));
      expect(sarifRoot(path.join(tmp, 'loose'), repo)).toBe(repo);
      process.env.GITHUB_WORKSPACE = tmp;
      expect(sarifRoot(path.join(repo, 'app'))).toBe(tmp);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('parses --fail-on', () => {
    expect(parseFailOn(undefined)).toBe('low');
    expect(parseFailOn('HIGH')).toBe('high');
    expect(parseFailOn('medium')).toBe('moderate');
    expect(parseFailOn('none')).toBe('none');
    expect(parseFailOn('severe')).toBeUndefined();
  });
});
