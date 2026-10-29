/**
 * Which files the import check reads: Python and JS/TS sources and their
 * manifests. Kept apart from imports.ts so the hook can answer "not a file we
 * look at" without loading the registry and lockfile code behind it.
 */
export type Lang = 'python' | 'js';

const PY_SOURCE = /\.pyw?$/i;
const JS_SOURCE = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro)$/i;
const PY_MANIFEST = /(^|[\\/])(requirements[^\\/]*\.(txt|in)|pyproject\.toml)$/i;
const JS_MANIFEST = /(^|[\\/])package\.json$/i;

export function languageOf(file: string): { lang: Lang; manifest: boolean } | undefined {
  if (/node_modules|[\\/]site-packages[\\/]|[\\/]\.?venv[\\/]/.test(file)) return undefined;
  if (PY_MANIFEST.test(file)) return { lang: 'python', manifest: true };
  if (JS_MANIFEST.test(file)) return { lang: 'js', manifest: true };
  if (PY_SOURCE.test(file)) return { lang: 'python', manifest: false };
  if (JS_SOURCE.test(file) && !/\.d\.[mc]?ts$/i.test(file)) return { lang: 'js', manifest: false };
  return undefined;
}
