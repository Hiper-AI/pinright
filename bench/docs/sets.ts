/**
 * Task sets of the docs benchmark. "v6" is the original eight (tasks.ts); "post-cutoff"
 * is the set whose APIs shipped after 2026-08-01 (tasks-post-cutoff.ts). Task ids are
 * unique across sets, so a scorer can find a task by id alone.
 */
import { POST_CUTOFF_TASKS } from './tasks-post-cutoff.js';
import { type DocsTask, TASKS } from './tasks.js';

export const TASK_SETS: Record<string, DocsTask[]> = { v6: TASKS, 'post-cutoff': POST_CUTOFF_TASKS };
export const DEFAULT_SET = 'v6';
export const ALL_TASKS: DocsTask[] = Object.values(TASK_SETS).flat();

export function taskSet(name: string): DocsTask[] {
  const set = TASK_SETS[name];
  if (!set) throw new Error(`unknown task set ${name}; known: ${Object.keys(TASK_SETS).join(', ')}`);
  return set;
}

/** --set <name> from argv, else the default. */
export function setFromArgs(args: string[], fallback = DEFAULT_SET): string {
  const i = args.indexOf('--set');
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
}
