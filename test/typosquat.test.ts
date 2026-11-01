import { describe, expect, it } from 'vitest';
import { editDistance, findLookalike } from '../src/typosquat.js';

describe('editDistance', () => {
  it('counts substitutions, insertions, deletions and swaps as one edit', () => {
    expect(editDistance('requests', 'reqeusts')).toBe(1);
    expect(editDistance('lodash', 'lodahs')).toBe(1);
    expect(editDistance('express', 'expres')).toBe(1);
    expect(editDistance('react', 'reactt')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
  });
});

describe('findLookalike', () => {
  it('flags a one-edit typo of a popular package', () => {
    expect(findLookalike('pypi', 'reqeusts')).toEqual({ of: 'requests', distance: 1 });
    expect(findLookalike('npm', 'lodahs')).toEqual({ of: 'lodash', distance: 1 });
  });

  it('does not flag the popular package itself, with any separator', () => {
    expect(findLookalike('pypi', 'requests')).toBeUndefined();
    expect(findLookalike('pypi', 'scikit_learn')).toBeUndefined();
    expect(findLookalike('npm', 'react-dom')).toBeUndefined();
  });

  it('is stricter with short names', () => {
    expect(findLookalike('npm', 'rct')).toBeUndefined(); // 2 edits from "react": too far for a 3-letter name
    expect(findLookalike('npm', 'reac')).toEqual({ of: 'react', distance: 1 });
    // Two edits in a 5- or 6-letter name is a different word, not a typo (found replaying public CI, bench/fp).
    expect(findLookalike('pypi', 'kenlm')).toBeUndefined();
    expect(findLookalike('npm', 'xterm')).toBeUndefined();
  });
});

describe('findLookalike on the generated top lists', () => {
  it('catches typos of names that were not in the hand-picked list', () => {
    expect(findLookalike('npm', 'expresss')).toEqual({ of: 'express', distance: 1 });
    expect(findLookalike('npm', 'lodahs')).toEqual({ of: 'lodash', distance: 1 });
    expect(findLookalike('npm', 'chokdiar')?.of).toBe('chokidar');
    expect(findLookalike('pypi', 'beautifulsop4')?.of).toBe('beautifulsoup4');
  });

  it('treats any listed name as the real thing', () => {
    for (const name of ['preact', 'chokidar', 'ansi-styles', 'botocore', 'typing-extensions']) {
      expect(findLookalike(name === 'botocore' || name === 'typing-extensions' ? 'pypi' : 'npm', name)).toBeUndefined();
    }
  });

  it('is fast enough to call on every check', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) findLookalike('npm', `some-unknown-package-${i}`);
    expect((performance.now() - t0) / 200).toBeLessThan(20);
  });
});
