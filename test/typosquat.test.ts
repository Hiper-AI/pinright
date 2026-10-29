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
  });
});
