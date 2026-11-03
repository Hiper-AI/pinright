/**
 * The benchmark's host jobs work outside this repository, so pinright's project detection cannot
 * adopt the repo's own lockfile (seen in the v7 runs, where the work folder sat under bench/).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencyFilesAbove, hostWorkDir } from '../bench/agents/harness.js';

const repo = path.resolve(import.meta.dirname, '..');
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('benchmark job folders', () => {
  it('a host job works under the temp directory, not inside the repo', () => {
    const runDir = path.join(repo, 'bench', 'docs', 'runs', 'docs-v8-sonnet');
    const work = hostWorkDir(runDir, { arm: 'pinright+hook', taskId: 'express5-api', rep: 2 }, '/base');
    expect(work).toBe(path.join('/base', 'pinright-bench', 'docs-v8-sonnet', 'pinright_hook', 'express5-api-r2', 'work'));
    expect(path.relative(repo, hostWorkDir(runDir, { arm: 'docs-only', taskId: 't', rep: 1 })).startsWith('..')).toBe(true);
  });

  it('finds dependency files in any folder above the job, which is what the v7 job folders had', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-harness-'));
    tmp.push(d);
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    const job = path.join(d, 'bench', 'runs', 'x', 'work');
    expect(dependencyFilesAbove(job)).toContain(path.join(d, 'package-lock.json'));
    expect(dependencyFilesAbove(path.join(repo, 'bench', 'docs', 'runs', 's', 'a', 't-r1', 'work'))).toContain(path.join(repo, 'package-lock.json'));
  });
});
