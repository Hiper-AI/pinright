/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON from composer files, read defensively */
/**
 * composer.json (require, require-dev) and composer.lock (packages, packages-dev).
 * Platform requirements (php, ext-*, lib-*, composer-*-api) are not packages.
 */
import type { ParsedTree, TreePackage } from '../tree/lockfiles.js';

export function isPlatformPackage(name: string): boolean {
  // php, php-64bit, ext-*, lib-*, composer-plugin-api...: platform names never have a vendor.
  return !name.includes('/');
}

export function composerDeclared(content: string): { name: string; spec: string; dev?: boolean }[] {
  const j = JSON.parse(content);
  const out: { name: string; spec: string; dev?: boolean }[] = [];
  for (const [name, spec] of Object.entries<any>(j.require ?? {})) {
    if (!isPlatformPackage(name)) out.push({ name: name.toLowerCase(), spec: String(spec) });
  }
  for (const [name, spec] of Object.entries<any>(j['require-dev'] ?? {})) {
    if (!isPlatformPackage(name)) out.push({ name: name.toLowerCase(), spec: String(spec), dev: true });
  }
  return out;
}

export function parseComposerJson(file: string, content: string): ParsedTree {
  return { ecosystem: 'composer', kind: 'manifest', file, packages: [], declared: composerDeclared(content) };
}

export function parseComposerLock(file: string, content: string, composerJson?: string): ParsedTree {
  const j = JSON.parse(content);
  let direct: Set<string> | undefined;
  if (composerJson) {
    try {
      direct = new Set(composerDeclared(composerJson).map((d) => d.name));
    } catch {
      // No usable composer.json: direct stays unknown.
    }
  }
  const packages: TreePackage[] = [];
  const add = (list: any, dev: boolean) => {
    for (const p of Array.isArray(list) ? list : []) {
      if (typeof p?.name !== 'string' || typeof p?.version !== 'string') continue;
      // dev-main and 1.x-dev are branches: no release to check advisories against.
      if (/^dev-|-dev$/i.test(p.version)) continue;
      const name = p.name.toLowerCase();
      packages.push({ name, version: p.version.replace(/^v(?=\d)/i, ''), dev, direct: direct ? direct.has(name) : undefined });
    }
  };
  add(j.packages, false);
  add(j['packages-dev'], true);
  return { ecosystem: 'composer', kind: 'lockfile', file, packages };
}
