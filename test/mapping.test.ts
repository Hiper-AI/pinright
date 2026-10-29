import { describe, expect, it } from 'vitest';
import { guessNames, pickPackage } from '../src/mapping.js';

describe('guessNames', () => {
  it('derives the usual package names from a repo', () => {
    expect(guessNames('vercel', 'next.js')).toEqual(expect.arrayContaining(['next.js', 'next', '@vercel/next.js']));
    expect(guessNames('psf', 'requests')[0]).toBe('requests');
    expect(guessNames('scikit-learn', 'scikit-learn')).toContain('scikit_learn');
    expect(guessNames('pallets', 'flask-sqlalchemy')).toContain('flask_sqlalchemy');
    expect(guessNames('upstash', 'upstash-redis')).toContain('redis');
  });
});

describe('pickPackage', () => {
  const rows = (list: [string, string, number][]) =>
    list.flatMap(([system, name, n]) =>
      Array.from({ length: n }, () => ({ system, name, relationType: 'SOURCE_REPO', relationProvenance: 'SLSA_ATTESTATION' })),
    );

  it('prefers the package named after the repo over scoped siblings', () => {
    const r = pickPackage('vercel', 'next.js', rows([['NPM', '@next/bundle-analyzer', 500], ['NPM', 'next', 30]]));
    expect(r).toMatchObject({ ecosystem: 'npm', name: 'next' });
  });

  it('ignores the pseudo Go module deps.dev invents for every GitHub repo', () => {
    const r = pickPackage('psf', 'requests', rows([['GO', 'github.com/psf/requests', 900], ['PYPI', 'requests', 31]]));
    expect(r).toMatchObject({ ecosystem: 'pypi', name: 'requests' });
  });

  it('keeps the Go module when the repo really has one', () => {
    const r = pickPackage('gin-gonic', 'gin', rows([['GO', 'github.com/gin-gonic/gin', 90]]), undefined, true);
    expect(r).toMatchObject({ ecosystem: 'go', name: 'github.com/gin-gonic/gin' });
  });

  it('returns nothing rather than a weak match from a capped list', () => {
    const r = pickPackage('prisma', 'prisma', rows([['NPM', '@prisma/accelerate-contract', 1500]]));
    expect(r).toBeUndefined();
  });

  it('respects a preferred ecosystem', () => {
    const r = pickPackage('tokio-rs', 'tokio', rows([['CARGO', 'tokio', 200], ['NPM', 'tokio', 3]]), 'npm');
    expect(r).toMatchObject({ ecosystem: 'npm', name: 'tokio' });
  });
});
