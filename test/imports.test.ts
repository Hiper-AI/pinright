/**
 * Undeclared imports: the parsers, the mapping to packages, and the hook notes
 * over real files in a temp project, with the registry mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = new Map<string, { verdict: string; safeVersion?: string }>(); // "eco:name"
vi.mock('../src/verdict.js', () => ({
  checkPackage: vi.fn(async (eco: string, name: string) => {
    const r = registry.get(`${eco}:${name}`) ?? { verdict: 'unknown-package' };
    return { report: { package: name, ecosystem: eco, checkedAt: '', sources: [], ...r } };
  }),
}));

const { jsImports, pythonImports, undeclaredImportNotes } = await import('../src/hook/imports.js');
const { npmPackageOf, pythonDistributions } = await import('../src/data/importNames.js');
const { importNotesFromToolInput } = await import('../src/hook/run.js');

let dir: string;
const write = (rel: string, content: string) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-imports-'));
  registry.clear();
  for (const [n, v] of [['langchain-text-splitters', '1.1.3'], ['pyyaml', '6.0.3'], ['numpy', '2.5.4'], ['requests', '2.34.2']]) registry.set(`pypi:${n}`, { verdict: 'ok', safeVersion: v });
  for (const [n, v] of [['zod', '4.6.7'], ['@tanstack/react-query', '5.90.0'], ['react', '19.2.0']]) registry.set(`npm:${n}`, { verdict: 'ok', safeVersion: v });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('pythonImports', () => {
  it('reads absolute imports and skips relative, docstring and guarded ones', () => {
    const src = [
      '"""Docs.',
      'import notreal',
      '"""',
      'from __future__ import annotations',
      'import os, json as j',
      'import a.b.c as d',
      'from langchain_text_splitters import RecursiveCharacterTextSplitter',
      'from .local import x',
      'from . import y',
      '# import commented',
      'try:',
      '    import ujson',
      'except ImportError:',
      '    import simplejson',
      'if TYPE_CHECKING:',
      '    import typing_only',
      'def f():',
      '    import numpy as np',
    ].join('\n');
    expect(pythonImports(src)).toEqual(['__future__', 'os', 'json', 'a.b.c', 'langchain_text_splitters', 'numpy']);
  });
});

describe('jsImports', () => {
  it('reads import/export/require/import() and keeps only registry packages', () => {
    const src = [
      "import React, { useState } from 'react';",
      "import type { Z } from 'zod';",
      "import { QueryClient } from '@tanstack/react-query/devtools';",
      "export * from 'lodash-es';",
      "import './styles.css';",
      "import fs from 'node:fs';",
      "import { readFile } from 'fs/promises';",
      "import Button from '@/components/Button';",
      "import cfg from '#config';",
      "import page from '$app/stores';",
      "const x = require('left-pad');",
      "const y = await import('chalk');",
      "// import nope from 'commented-out';",
      "/* import alsoNope from 'block-comment'; */",
      "import {\n  a,\n  b,\n} from 'multi-line';",
    ].join('\n');
    expect(jsImports(src).sort()).toEqual(['@tanstack/react-query', 'chalk', 'left-pad', 'lodash-es', 'multi-line', 'react', 'zod']);
  });

  it('sample code inside strings and template literals is not an import (tests, fixtures)', () => {
    const src = [
      "import { expect } from 'vitest';",
      'const a = "import React, { useState } from \'react\';";',
      "const b = 'const x = require(\"left-pad\")';",
      'const c = `import { streamText } from \'ai\';',
      "export default function Page() {}",
      "${'import x from \"next\"'}`;",
      'const d = `it\\`s fine`; const e = require(\'chalk\');',
      "const f = \"a ` backtick in a string\"; import g from 'zod';",
    ].join('\n');
    expect(jsImports(src).sort()).toEqual(['chalk', 'vitest', 'zod']);
  });

  it('npmPackageOf: subpaths, scopes, builtins and protocols', () => {
    expect(npmPackageOf('next/font/google')).toBe('next');
    expect(npmPackageOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(npmPackageOf('path')).toBeUndefined();
    expect(npmPackageOf('npm:zod')).toBeUndefined();
    expect(npmPackageOf('virtual:pwa-register')).toBeUndefined();
    expect(npmPackageOf('~/utils')).toBeUndefined();
  });
});

describe('pythonDistributions', () => {
  it('maps import names to distributions', () => {
    expect(pythonDistributions('yaml').dists[0]).toBe('pyyaml');
    expect(pythonDistributions('PIL.Image').dists[0]).toBe('pillow');
    expect(pythonDistributions('sklearn.linear_model').dists[0]).toBe('scikit-learn');
    expect(pythonDistributions('langchain_text_splitters')).toEqual({ dists: ['langchain-text-splitters'], curated: true, module: 'langchain_text_splitters' });
    expect(pythonDistributions('google.protobuf.message').dists[0]).toBe('protobuf');
    expect(pythonDistributions('google.cloud.storage')).toEqual({ dists: ['google-cloud-storage', 'google-cloud'], curated: false });
    expect(pythonDistributions('fastapi')).toEqual({ dists: ['fastapi'], curated: false });
  });
});

describe('undeclaredImportNotes', () => {
  it('the LangChain case: a source write imports a split package requirements.txt does not list', async () => {
    write('requirements.txt', 'langchain==1.4.7\nlangchain-openai==1.7.3\nPyYAML==6.0.3\nscikit-learn==1.7.0\n');
    write('app/utils.py', 'X = 1\n');
    const main = path.join(dir, 'main.py');
    const src = [
      'import os',
      'import yaml',
      'import sklearn',
      'from langchain_openai import ChatOpenAI',
      'from langchain_text_splitters import RecursiveCharacterTextSplitter',
      'from app.utils import X',
      'import main_helpers',
      'import totally_unknown_pkg',
    ].join('\n');
    write('main_helpers.py', '');
    const notes = await undeclaredImportNotes(main, src, undefined);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('main.py imports `langchain_text_splitters`, but requirements.txt does not declare langchain-text-splitters');
    expect(notes[0]).toContain('`langchain-text-splitters==1.1.3`');
  });

  it('only imports new in this write count, and nothing is said without a manifest', async () => {
    write('requirements.txt', 'flask==3.1.3\n');
    const f = path.join(dir, 'app.py');
    expect(await undeclaredImportNotes(f, 'import numpy\nimport requests\n', 'import numpy\n')).toEqual([expect.stringContaining('`requests`')]);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pinright-bare-'));
    fs.mkdirSync(path.join(bare, '.git'));
    expect(await undeclaredImportNotes(path.join(bare, 'x.py'), 'import numpy\n', undefined)).toEqual([]);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('a manifest write checks the project sources against the new content', async () => {
    write('src/rag.py', 'import numpy\nfrom langchain_text_splitters import X\n');
    write('pyproject.toml', '[project]\nname = "rag"\ndependencies = ["numpy>=2"]\n');
    const notes = await undeclaredImportNotes(path.join(dir, 'pyproject.toml'), '[project]\nname = "rag"\ndependencies = ["numpy>=2", "langchain-text-splitters>=1.1"]\n', undefined);
    expect(notes).toEqual([]);
    const missing = await undeclaredImportNotes(path.join(dir, 'pyproject.toml'), '[project]\nname = "rag"\ndependencies = ["numpy>=2"]\n', undefined);
    expect(missing[0]).toContain('src/rag.py'.replace('/', path.sep));
  });

  it('js: package.json deps, workspace and alias imports are fine; the rest is noted with a pin', async () => {
    write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '19.2.0' }, devDependencies: { typescript: '5.9.0' } }));
    write('tsconfig.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } } }');
    write('packages/ui/package.json', JSON.stringify({ name: '@acme/ui' }));
    write('lib/format.ts', 'export const f = 1;');
    const src = [
      "import React from 'react';",
      "import { z } from 'zod';",
      "import { QueryClient } from '@tanstack/react-query';",
      "import { Button } from '@acme/ui';",
      "import { thing } from '@app/thing';",
      "import { f } from 'lib/format';",
      "import fs from 'node:fs';",
      "import nope from 'not-on-npm-at-all';",
    ].join('\n');
    const notes = await undeclaredImportNotes(path.join(dir, 'src', 'index.tsx'), src, undefined);
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).toContain('`"zod": "4.6.7"` (npm install zod@4.6.7)');
    expect(notes.join('\n')).toContain('@tanstack/react-query');
  });

  it('hook input: Write of a source file yields notes; a shell command yields none', async () => {
    write('requirements.txt', 'flask==3.1.3\n');
    const notes = await importNotesFromToolInput({ file_path: 'app.py', content: 'import requests\n' }, dir);
    expect(notes[0]).toContain('`requests==2.34.2`');
    expect(await importNotesFromToolInput({ command: 'python app.py' }, dir)).toEqual([]);
    expect(await importNotesFromToolInput({ file_path: 'README.md', content: 'import requests' }, dir)).toEqual([]);
  });
});
