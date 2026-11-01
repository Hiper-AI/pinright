/**
 * Library search with no docs index: turn "next.js" or "pytorch" into registry
 * packages. Registries have no good fuzzy search (npm's ranks "next.js" the
 * package above "next"), so we generate likely names, check which exist, and
 * rank them by the stars of their source repository on deps.dev.
 */
import { getPackage, getProject, getVersion } from './advisories/depsdev.js';
import { cached } from './cache.js';
import { config } from './config.js';
import { type Ecosystem, ECOSYSTEMS, parseEcosystem } from './ecosystems.js';
import { getJson } from './http.js';

export interface LibraryHit {
  id: string;
  ecosystem: Ecosystem;
  name: string;
  repo?: string;
  stars?: number;
  latestVersion?: string;
  via: 'name' | 'alias' | 'registry-search';
  score: number;
}

export interface LibraryRef {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
}

/** "npm:next", "npm:@scope/pkg@1.2.3", "pypi:requests@2.32.5", "maven:org.x:y@1.0". */
export function formatLibraryId(eco: Ecosystem, name: string, version?: string): string {
  return `${eco}:${name}${version ? `@${version}` : ''}`;
}

export function parseLibraryRef(id: string): LibraryRef | undefined {
  const m = id.trim().match(/^([a-z.]+):(.+)$/i);
  if (!m) return undefined;
  const eco = parseEcosystem(m[1]);
  if (!eco) return undefined;
  const rest = m[2];
  const at = rest.lastIndexOf('@');
  if (at > 0) return { ecosystem: eco, name: rest.slice(0, at), version: rest.slice(at + 1).replace(/^v(?=\d)/, '') || undefined };
  return { ecosystem: eco, name: rest };
}

/** Common names that are not the package name. Keep short; the name search covers the rest. */
const NAME_ALIASES: Record<string, string[]> = {
  'next.js': ['npm:next'], nextjs: ['npm:next'], next: ['npm:next'],
  'vue.js': ['npm:vue'], vuejs: ['npm:vue'],
  'nuxt.js': ['npm:nuxt'], nuxtjs: ['npm:nuxt'],
  'react router': ['npm:react-router'], 'react-router-dom': ['npm:react-router-dom'],
  'tanstack query': ['npm:@tanstack/react-query'], 'react query': ['npm:@tanstack/react-query'],
  'auth.js': ['npm:next-auth', 'npm:@auth/core'], authjs: ['npm:next-auth', 'npm:@auth/core'], nextauth: ['npm:next-auth'],
  'express.js': ['npm:express'], expressjs: ['npm:express'],
  'node.js': [], nodejs: [],
  'mcp sdk': ['npm:@modelcontextprotocol/sdk', 'pypi:mcp'], 'model context protocol': ['npm:@modelcontextprotocol/sdk', 'pypi:mcp'],
  'aws sdk': ['npm:@aws-sdk/client-s3', 'pypi:boto3'], boto: ['pypi:boto3'],
  'anthropic sdk': ['npm:@anthropic-ai/sdk', 'pypi:anthropic'], 'openai sdk': ['npm:openai', 'pypi:openai'],
  pytorch: ['pypi:torch'], sklearn: ['pypi:scikit-learn'], 'scikit learn': ['pypi:scikit-learn'],
  beautifulsoup: ['pypi:beautifulsoup4'], bs4: ['pypi:beautifulsoup4'], opencv: ['pypi:opencv-python'], pil: ['pypi:pillow'],
  'ruby on rails': ['rubygems:rails'], tokio: ['cargo:tokio'], serde: ['cargo:serde'],
  'tailwind css': ['npm:tailwindcss'], tailwind: ['npm:tailwindcss'], 'chart.js': ['npm:chart.js'], 'three.js': ['npm:three'],
  'socket.io': ['npm:socket.io'], 'd3.js': ['npm:d3'], prisma: ['npm:prisma', 'npm:@prisma/client'], drizzle: ['npm:drizzle-orm'],
  gin: ['go:github.com/gin-gonic/gin'], echo: ['go:github.com/labstack/echo/v4'], gorm: ['go:gorm.io/gorm'],
};

const HINTS: [RegExp, Ecosystem][] = [
  [/\b(python|pip|pypi|django|flask|fastapi|pandas|py)\b/i, 'pypi'],
  [/\b(rust|cargo|crate|tokio)\b/i, 'cargo'],
  [/\b(ruby|gem|rails|bundler)\b/i, 'rubygems'],
  [/\b(golang|go module|go get)\b/i, 'go'],
  [/\b(java|kotlin|maven|gradle|spring)\b/i, 'maven'],
  [/\b(c#|dotnet|\.net|nuget)\b/i, 'nuget'],
  [/\b(node|npm|javascript|typescript|react|vue|next|deno|bun)\b/i, 'npm'],
];

export function ecosystemHint(text: string): Ecosystem | undefined {
  return HINTS.find(([re]) => re.test(text))?.[1];
}

export function nameVariants(raw: string): string[] {
  const s = raw.trim().toLowerCase();
  const out = new Set<string>([s]);
  const noJs = s.replace(/\.js$|[\s-]js$/, '');
  out.add(noJs);
  out.add(noJs.replace(/\s+/g, '-'));
  out.add(noJs.replace(/[\s.]+/g, ''));
  out.add(s.replace(/\s+/g, '-'));
  return [...out].filter((x) => x && /^[@a-z0-9][a-z0-9@/._-]*$/.test(x));
}

async function npmSearch(text: string): Promise<string[]> {
  const res = await cached(`npm:search:${text}`, config.ttl.search, () =>
    getJson<{ objects: { package: { name: string } }[] }>(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=5`),
  ).catch(() => ({ objects: [] }));
  return res.objects.map((o) => o.package.name);
}

async function cratesSearch(text: string): Promise<string[]> {
  const res = await cached(`crates:search:${text}`, config.ttl.search, () =>
    getJson<{ crates: { id: string }[] }>(`https://crates.io/api/v1/crates?q=${encodeURIComponent(text)}&per_page=5`),
  ).catch(() => ({ crates: [] }));
  return res.crates.map((c) => c.id);
}

async function describe(eco: Ecosystem, name: string, via: LibraryHit['via'], base: number): Promise<LibraryHit | undefined> {
  const pkg = await getPackage(eco, name).catch(() => undefined);
  if (!pkg?.versions.length) return undefined;
  const latest = pkg.versions.find((v) => v.isDefault)?.versionKey.version ?? pkg.versions[pkg.versions.length - 1].versionKey.version;
  const v = await getVersion(eco, name, latest).catch(() => undefined);
  const project = v?.relatedProjects?.find((p) => p.relationType === 'SOURCE_REPO')?.projectKey.id ?? v?.relatedProjects?.[0]?.projectKey.id;
  const proj = project ? await getProject(project).catch(() => undefined) : undefined;
  const stars = proj?.starsCount;
  return {
    id: formatLibraryId(eco, name),
    ecosystem: eco,
    name,
    repo: project,
    stars,
    latestVersion: latest,
    via,
    score: base + (stars ? Math.log10(stars + 1) : 0) + Math.min(pkg.versions.length, 200) / 400,
  };
}

export async function searchPackages(libraryName: string, query = '', ecosystem?: string): Promise<LibraryHit[]> {
  const explicit = parseLibraryRef(libraryName);
  if (explicit) {
    const hit = await describe(explicit.ecosystem, explicit.name, 'name', 10);
    return hit ? [hit] : [];
  }
  const hint = parseEcosystem(ecosystem) ?? ecosystemHint(`${libraryName} ${query}`);
  const ecos: Ecosystem[] = parseEcosystem(ecosystem) ? [hint as Ecosystem] : ['npm', 'pypi', 'cargo', 'rubygems'];
  const key = libraryName.trim().toLowerCase();

  const tries: { eco: Ecosystem; name: string; via: LibraryHit['via']; base: number }[] = [];
  for (const a of NAME_ALIASES[key] ?? NAME_ALIASES[key.replace(/\.js$/, '')] ?? []) {
    const ref = parseLibraryRef(a);
    if (ref && (!parseEcosystem(ecosystem) || ref.ecosystem === hint)) tries.push({ eco: ref.ecosystem, name: ref.name, via: 'alias', base: 6 });
  }
  const variants = nameVariants(libraryName);
  for (const eco of ecos) {
    for (const [i, n] of variants.entries()) {
      if (n.startsWith('@') && eco !== 'npm') continue;
      tries.push({ eco, name: n, via: 'name', base: (eco === hint ? 3 : 0) + (i === 0 ? 1 : 0.5) });
    }
  }
  if (key.includes('/') && (hint === 'go' || /\.(com|io|org|dev|in)\//.test(key))) tries.push({ eco: 'go', name: key, via: 'name', base: 4 });
  if (!hint || hint === 'npm') (await npmSearch(libraryName)).forEach((n, i) => tries.push({ eco: 'npm', name: n, via: 'registry-search', base: (hint === 'npm' ? 2 : 0) - i * 0.3 }));
  if (hint === 'cargo') (await cratesSearch(libraryName)).forEach((n, i) => tries.push({ eco: 'cargo', name: n, via: 'registry-search', base: 2 - i * 0.3 }));

  const seen = new Set<string>();
  const unique = tries.filter((t) => {
    const k = `${t.eco}:${t.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const hits = (await Promise.all(unique.map((t) => describe(t.eco, t.name, t.via, t.base)))).filter((h): h is LibraryHit => Boolean(h));

  // One entry per repo+ecosystem: "next" and "next.js"-the-squatter both claim vercel/next.js only if they really do.
  return hits.sort((a, b) => b.score - a.score).slice(0, 5);
}

export { ECOSYSTEMS };
