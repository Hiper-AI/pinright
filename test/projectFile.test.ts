/**
 * Files from an untrusted checkout: a dependency file that links outside the
 * project, a device or a huge file must not be read (security review F2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/auditRun.js';
import { ProjectFileError, readProjectFile, readProjectFileIfOk } from '../src/projectFile.js';
import { readSiblings } from '../src/tree/discover.js';

let tmp: string;
let repo: string;
let secret: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-pf-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  secret = path.join(tmp, 'secret.env');
  fs.writeFileSync(secret, 'API_KEY=sk-live-1234567890\n');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Symlinks need a privilege on Windows; without it the link tests are skipped. */
function link(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('readProjectFile', () => {
  it('reads a regular file inside the project', () => {
    fs.writeFileSync(path.join(repo, 'requirements.txt'), 'flask==3.0.0\n');
    expect(readProjectFile(path.join(repo, 'requirements.txt'))).toBe('flask==3.0.0\n');
  });

  it('refuses a link that leaves the project, without echoing the content', (ctx) => {
    const f = path.join(repo, 'requirements.txt');
    if (!link(secret, f)) return ctx.skip();
    expect(() => readProjectFile(f)).toThrow(ProjectFileError);
    try {
      readProjectFile(f);
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-live');
    }
    expect(readProjectFileIfOk(f)).toBeUndefined();
  });

  it('refuses a file under a directory link that leaves the root (junctions need no privilege on Windows)', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'requirements.txt'), 'API_KEY=sk-live-1234567890\n');
    fs.symlinkSync(outside, path.join(repo, 'sub'), 'junction');
    expect(() => readProjectFile(path.join(repo, 'sub', 'requirements.txt'), { root: repo })).toThrow(/links outside/);
    expect(readProjectFile(path.join(repo, 'sub', 'requirements.txt'), { root: repo, allowOutside: true })).toContain('API_KEY');
  });

  it('follows a link that stays inside the project', (ctx) => {
    fs.mkdirSync(path.join(repo, 'real'));
    fs.writeFileSync(path.join(repo, 'real', 'package.json'), '{}');
    if (!link(path.join(repo, 'real', 'package.json'), path.join(repo, 'real', 'alias.json'))) return ctx.skip();
    expect(readProjectFile(path.join(repo, 'real', 'alias.json'))).toBe('{}');
  });

  it('refuses directories and files over the cap', () => {
    fs.mkdirSync(path.join(repo, 'go.mod'));
    expect(() => readProjectFile(path.join(repo, 'go.mod'))).toThrow(/not a regular file/);
    fs.writeFileSync(path.join(repo, 'yarn.lock'), 'x'.repeat(2000));
    expect(() => readProjectFile(path.join(repo, 'yarn.lock'), { maxBytes: 1000 })).toThrow(/larger than 1000 bytes/);
    expect(readProjectFile(path.join(repo, 'yarn.lock'), { maxBytes: 2000 })).toHaveLength(2000);
  });

  it('the audit fails instead of reading a lockfile that links outside the project', async (ctx) => {
    if (!link(secret, path.join(repo, 'requirements.txt'))) return ctx.skip();
    await expect(runAudit({ target: repo, supplyChain: false })).rejects.toThrow(ProjectFileError);
  });

  it('a sibling that links outside is left out', (ctx) => {
    fs.writeFileSync(path.join(repo, 'yarn.lock'), '');
    if (!link(secret, path.join(repo, 'package.json'))) return ctx.skip();
    expect(readSiblings(path.join(repo, 'yarn.lock'))).toEqual({});
  });
});
