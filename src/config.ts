import os from 'node:os';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cacheDir(): string {
  if (process.env.SAFECTX_CACHE_DIR) return process.env.SAFECTX_CACHE_DIR;
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.cache'));
  return path.join(base, 'safectx');
}

export const config = {
  context7ApiKey: process.env.CONTEXT7_API_KEY ?? '',
  context7BaseUrl: process.env.CONTEXT7_BASE_URL ?? 'https://context7.com',
  depsDevBaseUrl: process.env.DEPSDEV_BASE_URL ?? 'https://api.deps.dev',
  osvBaseUrl: process.env.OSV_BASE_URL ?? 'https://api.osv.dev',
  /** Versions published fewer than this many days ago are not considered "safe" yet. */
  cooldownDays: intEnv('SAFECTX_COOLDOWN_DAYS', 3),
  /** How many candidate versions to inspect before giving up on a safe one. */
  maxCandidates: intEnv('SAFECTX_MAX_CANDIDATES', 12),
  requestTimeoutMs: intEnv('SAFECTX_TIMEOUT_MS', 15_000),
  cacheDir: cacheDir(),
  cacheDisabled: process.env.SAFECTX_NO_CACHE === '1',
  ttl: {
    docs: 7 * 24 * 3600_000,
    search: 24 * 3600_000,
    versions: 24 * 3600_000,
    advisories: 24 * 3600_000,
    registry: 24 * 3600_000,
  },
} as const;
