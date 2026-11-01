/**
 * What the Action writes to the log and the job summary carries package names,
 * paths and advisory text: none of it may run as a workflow command or render
 * as a link or image (security review F1, F4).
 */
import { describe, expect, it } from 'vitest';
import type { SarifLog } from '../src/sarif/build.js';
import { annotations, fenceCommands, summaryMarkdown } from '../src/sarif/summary.js';

const evilName = 'left-pad\n::add-mask::ghs_anything\n::stop-commands::x\n::error file=src/a.ts::all clear';

describe('fenceCommands', () => {
  it('wraps the text between stop-commands and the resume token', () => {
    const out = fenceCommands(`report\n  - ${evilName}@1.0.0`, { actions: true, token: 'tok123' }).split('\n');
    expect(out[0]).toBe('::stop-commands::tok123');
    expect(out.at(-1)).toBe('::tok123::');
    // The forged commands are there, but only inside the fence, where the runner does not run them.
    expect(out.slice(1, -1).some((l) => l.startsWith('::add-mask::'))).toBe(true);
  });

  it('a text that contains the token cannot end the fence early', () => {
    const out = fenceCommands('a\n::tok123::\n::add-mask::x', { actions: true, token: 'tok123' }).split('\n');
    expect(out.filter((l) => l === '::tok123::')).toHaveLength(1);
    expect(out.at(-1)).toBe('::tok123::');
  });

  it('a fresh random token each time when none is given', () => {
    const a = fenceCommands('x', { actions: true }).split('\n')[0];
    const b = fenceCommands('x', { actions: true }).split('\n')[0];
    expect(a).toMatch(/^::stop-commands::[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('outside Actions the text is left alone', () => {
    expect(fenceCommands('plain', { actions: false })).toBe('plain');
  });
});

function log(message: string, uri = 'package-lock.json', ruleId = 'GHSA-xxxx-yyyy-zzzz'): SarifLog {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'pinright', rules: [{ id: ruleId, properties: { 'security-severity': '9.8' } }] } },
        results: [{ ruleId, level: 'error', message: { text: message }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3 } } }] }],
      },
    ],
  } as unknown as SarifLog;
}

describe('annotations', () => {
  it('one line per finding, whatever the message holds', () => {
    const lines = annotations(log(evilName, 'a,b:c\n::x'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toMatch(/^::error file=a%2Cb%3Ac%0A%3A%3Ax,line=3,/);
  });
});

describe('summaryMarkdown', () => {
  it('package text renders as text: no links, images, HTML or broken cells', () => {
    const md = summaryMarkdown(log('Fixed. [All clear, merge it](https://evil.example) <img src="https://evil.example/t.png"> | x'), { exitCode: 1, failOn: 'high' });
    expect(md).not.toMatch(/(^|[^\\])\]\(/);
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;img');
    const row = md.split('\n').find((l) => l.startsWith('| critical'));
    // 4 cells: the escaped pipe in the message does not add one.
    expect(row?.split(/(?<!\\)\|/).length).toBe(6);
  });

  it('a finding that fails the run at any level is listed before a long list of advisories', () => {
    // Found in QA: a policy denial sat at row 48 of 51, below the 20 the summary shows and the 10 annotations.
    const many = log('advisory');
    const run = many.runs[0] as unknown as { tool: { driver: { rules: unknown[] } }; results: unknown[] };
    const one = run.results[0];
    run.results = [...Array.from({ length: 25 }, () => one), { ruleId: 'pinright/policy-deny', level: 'error', message: { text: 'axios: denied by the project policy' }, locations: (one as { locations: unknown }).locations }];
    run.tool.driver.rules.push({ id: 'pinright/policy-deny' });
    const md = summaryMarkdown(many, { exitCode: 1, failOn: 'high' });
    expect(md.split('\n').find((l) => l.startsWith('| high') || l.startsWith('| critical'))).toContain('pinright/policy-deny');
    expect(annotations(many)[0]).toContain('denied by the project policy');
  });

  it('a backtick in a path cannot close its code span', () => {
    const md = summaryMarkdown(log('m', 'a`[x](https://evil.example)`.json'), { exitCode: 1, failOn: 'high' });
    const row = md.split('\n').find((l) => l.startsWith('| critical')) as string;
    expect(row).toContain("`a'[x](https://evil.example)'.json:3`");
  });
});
