import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { docsSourceFor, normalizePypiName, siblingsFor } from '../src/data/docsRepos.js';
import { readTarGz, readZip } from '../src/docs/archive.js';
import { distLayout, parseModule, pyStatements, renderDistribution, renderModule, resolveRelative, wantEntry } from '../src/docs/pyapi.js';
import { packageNotes, pickDistribution } from '../src/docs/python.js';
import { chunkPython } from '../src/docs/retrieve.js';
import { keepLanguage } from '../src/docs/sources.js';

// ------------------------------------------------------------ fixtures ------

/** A minimal ZIP writer: one deflated entry and one stored entry are enough to exercise the reader. */
function makeZip(files: Record<string, string>, store: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const stored = store.includes(name);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write(size.toString(8).padStart(11, '0'), 124);
  h.write(type, 156);
  h.write('ustar', 257);
  return h;
}

function makeTarGz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    if (name.length > 100) {
      // GNU long name entry
      const long = Buffer.from(`${name}\0`);
      parts.push(tarHeader('././@LongLink', long.length, 'L'), long, pad(long.length));
    }
    parts.push(tarHeader(name, data.length), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

// ------------------------------------------------------------ archives ------

describe('archives', () => {
  it('zip: reads deflated and stored entries, only the wanted ones', () => {
    const zip = makeZip({ 'pkg/__init__.py': 'x = 1\n', 'pkg/data.bin': 'zzz', 'pkg-1.0.dist-info/top_level.txt': 'pkg\n' }, ['pkg-1.0.dist-info/top_level.txt']);
    const entries = readZip(zip, { want: wantEntry });
    expect(entries.map((e) => e.name).sort()).toEqual(['pkg-1.0.dist-info/top_level.txt', 'pkg/__init__.py']);
    expect(entries.find((e) => e.name === 'pkg/__init__.py')!.data.toString()).toBe('x = 1\n');
  });

  it('zip: entries over the size cap are skipped; garbage is rejected', () => {
    const zip = makeZip({ 'pkg/big.py': 'a'.repeat(5000) });
    expect(readZip(zip, { want: () => true, maxEntryBytes: 1000 })).toEqual([]);
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'), { want: () => true })).toThrow();
  });

  it('zip: thousands of central entries pointing at one small deflate stream stay under the total cap (security review F8)', () => {
    // One local entry that inflates to 1 MB; the central directory lists it 3000 times.
    const one = makeZip({ 'pkg/a.py': '#'.repeat(1_000_000) });
    const eocdAt = one.length - 22;
    const cdStart = one.readUInt32LE(eocdAt + 16);
    const central = one.subarray(cdStart, eocdAt);
    const copies = 3000;
    const cd = Buffer.concat(Array.from({ length: copies }, () => central));
    const eocd = Buffer.from(one.subarray(eocdAt));
    eocd.writeUInt16LE(copies, 8);
    eocd.writeUInt16LE(copies, 10);
    eocd.writeUInt32LE(cd.length, 12);
    const bomb = Buffer.concat([one.subarray(0, cdStart), cd, eocd]);
    expect(bomb.length).toBeLessThan(200_000); // ~3 GB if every entry were inflated
    const entries = readZip(bomb, { want: () => true, maxEntryBytes: 1_000_000, maxTotalOutBytes: 10_000_000 });
    const total = entries.reduce((n, e) => n + e.data.length, 0);
    expect(total).toBeLessThanOrEqual(10_000_000);
    expect(entries.length).toBe(10);
  });

  it('tar.gz: reads files, GNU long names, and filters', () => {
    const deep = `pkg-1.0/src/pkg/${'d'.repeat(90)}/mod.py`;
    const tgz = makeTarGz({ 'pkg-1.0/PKG-INFO': 'Name: pkg', 'pkg-1.0/src/pkg/__init__.py': '"""Pkg."""\n', [deep]: 'def f(): ...\n' });
    const entries = readTarGz(tgz, { want: (n) => n.endsWith('.py') });
    expect(entries.map((e) => e.name)).toEqual(['pkg-1.0/src/pkg/__init__.py', deep]);
  });
});

// ------------------------------------------------------------ python API ----

const SRC = `"""Tools for widgets.

Longer description.
"""
from typing import overload
from ._impl import Engine, _helper
from . import sub as sub

__all__ = ["make", "Widget", "VERSION"]

VERSION = "1.2"
DEBUG = True

def make(name: str,
         size: int = 3) -> "Widget":
    """Make a widget.

    Args:
        name: the name.
    """
    return Widget(name)

def helper():
    """Not in __all__."""

def _private():
    pass

class Widget(Base):
    """A widget."""

    color: str = "red"
    _secret = 1

    def __init__(self, name):
        self.name = name

    @property
    def area(self) -> int:
        """Area in cm2."""
        return 1

    def _internal(self): ...

if sys.version_info >= (3, 11):
    def later(): ...
`;

describe('python API extraction', () => {
  it('joins logical lines across brackets and strings, drops comments', () => {
    const s = pyStatements('x = (1,\n  2)  # c\ns = """a\nb"""\nif a:\n    y = 1\n');
    expect(s.map((x) => [x.indent, x.text])).toEqual([[0, 'x = (1,\n  2)'], [0, 's = """a\nb"""'], [0, 'if a:'], [4, 'y = 1']]);
  });

  it('parses docstrings, __all__, imports and class members', () => {
    const mod = parseModule(SRC);
    expect(mod.doc).toBe('Tools for widgets.\n\nLonger description.');
    expect(mod.all).toEqual(['make', 'Widget', 'VERSION']);
    expect(mod.imports.map((i) => i.from)).toEqual(['typing', '._impl', '.']);
    const widget = mod.defs.find((d) => d.name === 'Widget')!;
    expect(widget.doc).toBe('A widget.');
    expect(widget.members.map((m) => m.name)).toEqual(['color', '__init__', 'area', '_internal']);
  });

  it('renders only what __all__ exports, with signatures and docstrings', () => {
    const out = renderModule('widgets/core.py', parseModule(SRC));
    expect(out).toContain('# module widgets.core');
    expect(out).toContain('def make(name: str,\n    size: int = 3) -> "Widget":\n    """Make a widget.');
    expect(out).toContain('VERSION = "1.2"');
    expect(out).toContain('class Widget(Base):\n    """A widget."""');
    expect(out).toContain('    @property\n    def area(self) -> int:\n        """Area in cm2."""');
    expect(out).toContain('    def __init__(self, name): ...');
    for (const hidden of ['helper', '_private', '_internal', '_secret', 'DEBUG', 'later']) expect(out).not.toContain(hidden);
  });

  it('without __all__, public names are those without a leading underscore', () => {
    const out = renderModule('widgets/core.py', parseModule(SRC.replace(/__all__ = .*\n/, '')));
    expect(out).toContain('def helper(): ...'.replace(': ...', ':'));
    expect(out).toContain('def later(): ...');
    expect(out).not.toContain('_private');
    expect(out).not.toContain('DEBUG'); // plain module constants only when __all__ lists them
  });

  it('keeps the implementation of an overloaded function, not the overloads', () => {
    const src = '@overload\ndef f(x: int) -> int: ...\n@overload\ndef f(x: str) -> str: ...\ndef f(x):\n    """Doc of f."""\n';
    const out = renderModule('m.py', parseModule(src));
    expect(out.match(/def f/g)).toHaveLength(1);
    expect(out).toContain('Doc of f.');
  });

  it('resolves relative imports and renders package re-exports', () => {
    expect(resolveRelative('pkg/sub/__init__.py', '._impl')).toBe('pkg.sub._impl');
    expect(resolveRelative('pkg/sub/mod.py', '..other')).toBe('pkg.other');
    expect(resolveRelative('pkg/mod.py', '.')).toBe('pkg');
    const out = renderModule('widgets/__init__.py', parseModule(SRC.replace('"VERSION"]', '"VERSION", "Engine"]')));
    expect(out).toContain('from widgets._impl import Engine');
    expect(out).not.toContain('_helper');
    // Names a package imports but leaves out of __all__ are not re-exports.
    expect(renderModule('widgets/__init__.py', parseModule(SRC))).not.toContain('import Engine');
  });

  it('a distribution: private modules show only re-exported names; stubs fill signatures; tests skipped', () => {
    const layout = distLayout(
      [
        { name: 'httpish/__init__.py', data: Buffer.from('from ._client import Client\n') },
        { name: 'httpish/_client.py', data: Buffer.from('class Client:\n    """HTTP client."""\n    def get(self, url):\n        """GET."""\n\ndef _build(): ...\n\ndef internal_only(): ...\n') },
        { name: 'httpish/tests/test_client.py', data: Buffer.from('def test_x(): ...\n') },
        { name: 'httpish-1.0.dist-info/top_level.txt', data: Buffer.from('httpish\n') },
      ],
      'wheel',
    );
    expect(layout.importNames).toEqual(['httpish']);
    expect(layout.typed).toBe(false);
    expect(layout.modules.map((m) => m.path)).toEqual(['httpish/__init__.py', 'httpish/_client.py']);
    const stubs = [{ path: 'httpish/_client.pyi', source: 'class Client:\n    def get(self, url: str) -> Response: ...\n' }];
    const rendered = renderDistribution(layout, stubs);
    const client = rendered.find((r) => r.path === 'httpish/_client.py')!.content;
    expect(client).toContain('def get(self, url: str) -> Response:\n        """GET."""');
    expect(client).not.toContain('internal_only');
  });

  it('sdist layout: strips name-version/ and src/, maps -stubs dirs, derives import names', () => {
    const layout = distLayout(
      [
        { name: 'pkg-1.0/setup.py', data: Buffer.from('setup()\n') },
        { name: 'pkg-1.0/src/pkg/__init__.py', data: Buffer.from('def f(): ...\n') },
        { name: 'pkg-1.0/src/pkg/py.typed', data: Buffer.from('') },
        { name: 'pkg-1.0/docs/conf.py', data: Buffer.from('x = 1\n') },
      ],
      'sdist',
    );
    expect(layout.modules.map((m) => m.path)).toEqual(['pkg/__init__.py']);
    expect(layout.importNames).toEqual(['pkg']);
    expect(layout.typed).toBe(true);
    expect(distLayout([{ name: 'yaml-stubs/__init__.pyi', data: Buffer.from('def safe_load(s: str) -> object: ...\n') }], 'wheel').modules[0].path).toBe('yaml/__init__.pyi');
  });

  it('chunks python per function and class; long classes per method', () => {
    const methods = Array.from({ length: 40 }, (_, i) => `    def m${i}(self) -> int:\n        """Method ${i} ${'x'.repeat(60)}."""`).join('\n\n');
    const text = `# module pkg.core\n"""Core."""\n\n@decorator\ndef f(x):\n    """F."""\n\nclass Big:\n    """Big class."""\n\n${methods}\n`;
    const chunks = chunkPython(text);
    expect(chunks[0].title).toBe('module pkg.core');
    expect(chunks[1]).toMatchObject({ title: 'def pkg.core.f' });
    expect(chunks[1].text.startsWith('@decorator\ndef f(x):')).toBe(true);
    expect(chunks[2]).toMatchObject({ title: 'class pkg.core.Big', text: 'class Big:\n    """Big class."""' });
    expect(chunks[3].title).toBe('class pkg.core.Big > def m0');
    expect(chunks[3].text).toMatch(/^class Big:\n {4}def m0/);
    expect(chunks).toHaveLength(43);
  });

  it('docstrings that contain "def" or "@" lines do not split chunks', () => {
    const chunks = chunkPython('# module m\n"""Example:\n\ndef not_a_def():\n@not_a_decorator\n"""\n\ndef real(): ...\n');
    expect(chunks.map((c) => c.title)).toEqual(['module m', 'def m.real']);
  });
});

// ------------------------------------------------------------ distribution choice and notes ---

describe('distributions and notes', () => {
  it('prefers a pure wheel, then the smallest wheel, then the sdist; respects the size cap', () => {
    const f = (filename: string, size = 1000) => ({ filename, url: `u/${filename}`, size });
    expect(pickDistribution([f('a-1.tar.gz'), f('a-1-cp312-win_amd64.whl'), f('a-1-py3-none-any.whl')])?.filename).toBe('a-1-py3-none-any.whl');
    expect(pickDistribution([f('a-1.tar.gz'), f('a-1-cp312-linux.whl', 900), f('a-1-cp312-win.whl', 800)])?.filename).toBe('a-1-cp312-win.whl');
    expect(pickDistribution([f('a-1.tar.gz'), f('a-1-cp312-linux.whl', 900_000_000)])?.filename).toBe('a-1.tar.gz');
  });

  it('tells which import name a package provides', () => {
    const notes = packageNotes({ name: 'pyyaml', version: '6.0.3', query: 'safe_load', text: '', importNames: ['yaml'], requiresDist: [] });
    expect(notes).toEqual(['Import name: `yaml` (the package installs as `pyyaml`).']);
    expect(packageNotes({ name: 'requests', version: '2', query: 'x', text: '', importNames: ['requests'], requiresDist: [] })).toEqual([]);
  });

  it('LangChain: names the sibling packages the query or the examples need, minus declared dependencies', () => {
    const notes = packageNotes({
      name: 'langchain',
      version: '1.4.7',
      query: 'split documents into chunks and use prompt templates',
      text: 'from langchain_openai import ChatOpenAI\nimport faiss\nfrom langchain.agents import create_agent',
      importNames: ['langchain'],
      requiresDist: ['langchain-core<2,>=1.2', 'langgraph>=1.0', 'langchain-openai; extra == "openai"'],
    }).join('\n');
    expect(notes).toContain('langchain-text-splitters (import `langchain_text_splitters`)');
    expect(notes).toContain('langchain-openai (import `langchain_openai`)');
    expect(notes).toContain('extra langchain[openai]');
    expect(notes).toContain('faiss-cpu (import `faiss`)');
    expect(notes).not.toContain('langchain-core'); // a declared dependency
  });

  it('maps npm packages whose docs live only in a site repo (Tailwind)', () => {
    const tw = docsSourceFor('npm', 'tailwindcss')?.repo;
    expect(tw).toMatchObject({ owner: 'tailwindlabs', repo: 'tailwindcss.com', paths: ['src/docs/'] });
    expect(docsSourceFor('npm', '@tailwindcss/vite')?.repo?.repo).toBe('tailwindcss.com');
    expect(tw?.fill?.test('src/docs/theme.mdx')).toBe(true);
    expect(tw?.fill?.test('src/docs/backdrop-filter-blur.mdx')).toBe(false);
    expect(docsSourceFor('npm', 'tailwindcss-animate')).toBeUndefined();
  });

  it('maps packages to docs living elsewhere', () => {
    expect(normalizePypiName('LangChain_Text.Splitters')).toBe('langchain-text-splitters');
    expect(docsSourceFor('pypi', 'LangChain_Text-Splitters')?.llmsIndex).toMatch(/docs\.langchain\.com/);
    expect(docsSourceFor('pypi', 'langchain-core')?.repo?.repo).toBe('docs');
    expect(docsSourceFor('pypi', 'PyYAML')?.repo).toMatchObject({ owner: 'yaml', repo: 'pyyaml.org' });
    expect(docsSourceFor('npm', 'langchain')).toBeUndefined();
    expect(docsSourceFor('pypi', 'langchainx')).toBeUndefined();
    expect(siblingsFor('langchain-openai').some((s) => s.pkg === 'langchain-text-splitters')).toBe(true);
    expect(siblingsFor('requests')).toEqual([]);
  });

  it('keeps one language of multi-language docs', () => {
    const md = 'intro\n:::python\npip install x\n:::\n:::js\nnpm i x\n:::\nend';
    expect(keepLanguage(md, 'python')).toBe('intro\npip install x\nend');
    expect(keepLanguage('```python theme={"theme":{"light":"a"}}\nx = 1\n```', 'python')).toBe('```python\nx = 1\n```');
  });
});
