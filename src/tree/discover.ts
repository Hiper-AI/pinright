/**
 * Which dependency files of a directory to read. Kept apart from project.ts so
 * the CLI audit (and the GitHub Action bundle) does not pull in the MCP SDK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readProjectFileIfOk } from '../projectFile.js';

const LOCK_PRIORITY = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'uv.lock', 'poetry.lock', 'pdm.lock', 'Cargo.lock', 'go.mod', 'Gemfile.lock', 'packages.lock.json',
  'requirements.txt', 'pyproject.toml', 'package.json', 'Cargo.toml',
  'gradle.lockfile', 'pom.xml', 'build.gradle.kts', 'build.gradle', 'gradle/libs.versions.toml',
  'composer.lock', 'composer.json',
];

function ecosystemOfFile(f: string): string {
  if (/gradle|pom\.xml|libs\.versions/.test(f)) return 'jvm';
  if (/composer/.test(f)) return 'composer';
  if (/package|pnpm|yarn|shrinkwrap/.test(f)) return /packages\.lock/.test(f) ? 'nuget' : 'npm';
  if (/Cargo/.test(f)) return 'cargo';
  if (/go\.mod/.test(f)) return 'go';
  if (/Gemfile/.test(f)) return 'ruby';
  return 'python';
}

/** In a directory, one file per ecosystem: the lockfile when there is one, else the manifest. */
export function manifestsIn(dir: string): string[] {
  const chosen: string[] = [];
  const taken = new Set<string>();
  for (const f of LOCK_PRIORITY) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    const eco = ecosystemOfFile(f);
    if (taken.has(eco)) continue;
    taken.add(eco);
    chosen.push(path.join(dir, f));
  }
  return chosen;
}

export function readSiblings(file: string): Record<string, string> {
  const dir = path.dirname(file);
  const out: Record<string, string> = {};
  for (const s of ['package.json', 'pyproject.toml', 'Cargo.toml', 'composer.json', 'build.gradle.kts', 'build.gradle', 'gradle.properties']) {
    const p = path.join(dir, s);
    if (path.basename(file) === s || !fs.existsSync(p)) continue;
    const text = readProjectFileIfOk(p);
    if (text !== undefined) out[s] = text;
  }
  // Gradle's version catalog lives in gradle/ next to the build script.
  const catalog = path.join(dir, 'gradle', 'libs.versions.toml');
  const text = fs.existsSync(catalog) ? readProjectFileIfOk(catalog, { root: dir }) : undefined;
  if (text !== undefined) out['libs.versions.toml'] = text;
  return out;
}
