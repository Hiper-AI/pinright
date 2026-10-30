import os from 'node:os';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cacheDir(): string {
  if (process.env.PINRIGHT_CACHE_DIR) return process.env.PINRIGHT_CACHE_DIR;
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.cache'));
  return path.join(base, 'pinright');
}

export const config = {
  /** Characters of documentation returned per get-docs call (about 4 per token). */
  docsBudgetChars: intEnv("PINRIGHT_DOCS_BUDGET", 10_000),
  depsDevBaseUrl: process.env.DEPSDEV_BASE_URL ?? 'https://api.deps.dev',
  osvBaseUrl: process.env.OSV_BASE_URL ?? 'https://api.osv.dev',
  /** Versions published fewer than this many days ago are not considered "safe" yet. */
  cooldownDays: intEnv('PINRIGHT_COOLDOWN_DAYS', 3),
  /** How many candidate versions to inspect before giving up on a safe one. */
  maxCandidates: intEnv('PINRIGHT_MAX_CANDIDATES', 12),
  requestTimeoutMs: intEnv('PINRIGHT_TIMEOUT_MS', 15_000),
  cacheDir: cacheDir(),
  cacheDisabled: process.env.PINRIGHT_NO_CACHE === '1',
  /** Size the cache is pruned down to (expired entries first, then the oldest). */
  cacheMaxBytes: intEnv('PINRIGHT_CACHE_MAX_MB', 200) * 1024 * 1024,
  ttl: {
    docs: 7 * 24 * 3600_000,
    search: 24 * 3600_000,
    versions: 24 * 3600_000,
    advisories: 24 * 3600_000,
    registry: 24 * 3600_000,
    /** A repo's file list at a release tag does not change: keep it a year. */
    tagged: 365 * 24 * 3600_000,
  },
} as const;

/** The team file (.pinright.json) may set the cooldown; PINRIGHT_COOLDOWN_DAYS still wins. */
export function applyCooldownDays(days: number | undefined): void {
  if (days === undefined || process.env.PINRIGHT_COOLDOWN_DAYS) return;
  (config as { cooldownDays: number }).cooldownDays = days;
}
