/**
 * Read-only: how many runs of a stamp ended in a successful result (what --resume would skip).
 *
 *   npx tsx bench/agents/check-resume.ts <agents|docs> <stamp>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { succeeded } from './harness.js';

const [kind, stamp] = process.argv.slice(2);
const runDir = join(resolve(import.meta.dirname, '..', '..'), 'bench', kind, 'runs', stamp);
let ok = 0;
const bad: string[] = [];
for (const arm of readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const run of readdirSync(join(runDir, arm.name))) {
    const tr = join(runDir, arm.name, run, 'transcript.jsonl');
    if (!existsSync(tr)) continue;
    if (succeeded(readFileSync(tr, 'utf8'))) ok++;
    else bad.push(`${arm.name}/${run}`);
  }
}
console.log(`${ok} succeeded, ${bad.length} did not${bad.length ? `: ${bad.join(' ')}` : ''}`);
