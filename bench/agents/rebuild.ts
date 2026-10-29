/**
 * Re-runs only the build check for runs whose build step matches a filter, and
 * updates scores.json in place. For fixing a harness bug without re-scoring all.
 *
 *   npx tsx bench/agents/rebuild.ts <stamp> <step-substring>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmBuild, pypiBuild } from './buildcheck.js';
import type { RunScore } from './score.js';

const [stamp, step] = process.argv.slice(2);
if (!stamp || !step) throw new Error('usage: rebuild.ts <stamp> <step-substring>');
const runDir = join(resolve(import.meta.dirname, '..', '..'), 'bench', 'agents', 'runs', stamp);
const file = join(runDir, 'scores.json');
const scores: RunScore[] = JSON.parse(readFileSync(file, 'utf8'));
for (const s of scores) {
  if (!s.build?.step.includes(step)) continue;
  const work = join(runDir, s.arm, `${s.task}-r${s.rep}`, 'work');
  s.build = s.ecosystem === 'npm' ? await npmBuild(work) : await pypiBuild(work);
  console.log(`${s.arm} ${s.task}-r${s.rep}: ${s.build.built ? 'ok' : `FAIL ${s.build.step}: ${s.build.error ?? ''}`}`);
}
writeFileSync(file, JSON.stringify(scores, null, 2));
