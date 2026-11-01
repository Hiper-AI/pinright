/**
 * The hook's own deadline (PINRIGHT_HOOK_TIMEOUT_MS). Kept apart from policy.ts so
 * run.ts can answer before the policy and the registries have even loaded.
 */

/** Default deadline: below the 60 s hook timeout `pinright init` writes, after which the agents let the change through. */
export const DEFAULT_HOOK_TIMEOUT_MS = 45_000;

/** PINRIGHT_HOOK_TIMEOUT_MS, or the default when unset or not a positive number (NaN would fire at once). */
export function hookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PINRIGHT_HOOK_TIMEOUT_MS);
  return env.PINRIGHT_HOOK_TIMEOUT_MS?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_HOOK_TIMEOUT_MS;
}

/** "a, b, c, d and 2 more". */
export function nameList(names: string[], max = 4): string {
  const u = [...new Set(names)];
  return u.length <= max ? u.join(', ') : `${u.slice(0, max).join(', ')} and ${u.length - max} more`;
}

/** The problem line when the deadline ran out before `names` were checked. */
export function lateProblem(names: string[], ms: number): string {
  const what = names.length ? nameList(names) : 'this change';
  return `pinright could not finish checking ${what} in time (${Math.round(ms / 100) / 10} s, PINRIGHT_HOOK_TIMEOUT_MS); a human should approve it, or retry once deps.dev and OSV answer.`;
}
