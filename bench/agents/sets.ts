/**
 * Task sets of the agent benchmark. `v6` is the set we wrote (tasks.ts); `real-issues` is
 * taken from public GitHub issues (tasks-real-issues.ts). run.ts records the set in the run's
 * config.json, and score.ts, make-latest.ts and report.ts read it from there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentTask, TASKS } from './tasks.js';
import { REAL_ISSUE_TASKS } from './tasks-real-issues.js';

export const SETS: Record<string, AgentTask[]> = { v6: TASKS, 'real-issues': REAL_ISSUE_TASKS };
export const DEFAULT_SET = 'v6';

export function taskSet(name: string = DEFAULT_SET): AgentTask[] {
  const set = SETS[name];
  if (!set) throw new Error(`unknown task set "${name}" (known: ${Object.keys(SETS).join(', ')})`);
  return set;
}

/** The set a run was made with: config.json's `set`, or v6 for runs made before sets existed. */
export function setOfRun(runDir: string): string {
  const p = join(runDir, 'config.json');
  if (!existsSync(p)) return DEFAULT_SET;
  return String(JSON.parse(readFileSync(p, 'utf8')).set ?? DEFAULT_SET);
}

export const tasksOfRun = (runDir: string) => taskSet(setOfRun(runDir));
