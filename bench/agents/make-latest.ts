/**
 * Reference arm with no agent in the loop: the same packages the no-docs agent
 * chose, installed without a version (`npm install x`, `pip install x`).
 * It answers "what if the agent never pins anything?".
 *
 *   npx tsx bench/agents/make-latest.ts <stamp>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TASKS } from './tasks.js';

const stamp = process.argv[2];
if (!stamp) throw new Error('usage: make-latest.ts <stamp>');
const runDir = join(resolve(import.meta.dirname, '..', '..'), 'bench', 'agents', 'runs', stamp);

for (const task of TASKS) {
  const src = join(runDir, 'no-docs', `${task.id}-r1`, 'work');
  const out = join(runDir, 'latest', `${task.id}-r1`, 'work');
  if (task.ecosystem === 'npm') {
    const p = join(src, 'package.json');
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const toLatest = (o: Record<string, string> | undefined) =>
      o ? Object.fromEntries(Object.keys(o).map((k) => [k, 'latest'])) : undefined;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'package.json'), JSON.stringify({
      name: j.name ?? task.id, version: '0.0.0', private: true,
      dependencies: toLatest(j.dependencies), devDependencies: toLatest(j.devDependencies),
    }, null, 2));
  } else {
    const p = join(src, 'requirements.txt');
    if (!existsSync(p)) continue;
    const names = readFileSync(p, 'utf8').split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l && !l.startsWith('-'))
      .map((l) => l.match(/^[A-Za-z0-9_.-]+(\[[^\]]*\])?/)?.[0] ?? l);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'requirements.txt'), names.join('\n') + '\n');
  }
}
console.log('latest arm written');
