/**
 * Prints every MCP call of one task and arm with its arguments and the start
 * of what it returned: the raw material for diagnosing a docs miss.
 *
 *   npx tsx bench/docs/calls.ts <stamp> <task> <arm> [--full]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { armDir as findArmDir, canonicalArm } from '../legacy.js';
import { readTranscript } from './score.js';

const [stamp, task, arm] = process.argv.slice(2);
if (!stamp || !task || !arm) throw new Error('usage: calls.ts <stamp> <task> <arm> [--full]');
const full = process.argv.includes('--full');
const armDir = findArmDir(join(resolve(import.meta.dirname, '..', '..'), 'bench', 'docs', 'runs', stamp), canonicalArm(arm));
for (const name of existsSync(armDir) ? readdirSync(armDir).filter((n) => n.startsWith(`${task}-r`)).sort() : []) {
  const t = readTranscript(join(armDir, name));
  console.log(`\n=== ${arm} ${name}: ${t.calls.length} calls, ${t.turns} turns, $${t.costUsd?.toFixed(3)}`);
  for (const c of t.calls) {
    console.log(`\n--- ${c.tool} ${JSON.stringify(c.input)} -> ${c.resultChars} chars`);
    console.log(full ? c.result : (c.result ?? '').slice(0, 1500));
  }
}
