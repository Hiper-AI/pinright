/**
 * False-positive corpus for the pre-install hook, from public repositories only.
 *
 * Picks popular repositories per ecosystem (GitHub search by stars), downloads the
 * files that carry shell commands and dependency manifests, and extracts what an
 * agent working in that repository would plausibly run or write:
 *
 *   - `run:` steps of GitHub Actions workflows (with their working-directory),
 *   - `RUN` instructions of Dockerfiles,
 *   - `npm run <script>` for every package.json script, plus `npm install` / `npm test`,
 *   - `make <target>` / `just <recipe>` for every Makefile target and justfile recipe,
 *   - command lines in shell code blocks of README and CONTRIBUTING files,
 *   - manifest writes: the current manifest written over the version before its last commit.
 *
 * The repository files are kept on disk (repos/<owner>__<repo>/...) so the hook reads
 * them as it would in a checkout: requirement files behind `-r`, scripts behind
 * `npm run`, recipes behind `make`. node_modules/.bin gets an empty file for each bin
 * the declared npm dependencies expose, as after `npm ci`, so `npx tsc` reads as local.
 *
 * Read-only on GitHub: search, one tree and a few commit lists per repository through
 * the API; file contents through raw.githubusercontent.com (jsDelivr as fallback).
 * Anything that looks like a credential in an extracted command is redacted.
 *
 * Run: GITHUB_TOKEN=... npx tsx bench/fp/collect.ts <corpus-dir> [--per-language 14]
 * Output: <corpus-dir>/repos.json, repos/, wcases/, corpus.jsonl. Re-runs reuse what is there.
 */
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: collect.ts <corpus-dir> [--per-language N]');
  process.exit(2);
}
const perLanguage = Number(process.argv[process.argv.indexOf('--per-language') + 1]) || 14;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required (the search and tree APIs).');
  process.exit(2);
}

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'PHP', 'Ruby', 'C#'];
/** Monorepos and toolchains worth having whatever their rank. */
const EXTRA = [
  'vercel/next.js', 'vercel/turborepo', 'nrwl/nx', 'babel/babel', 'facebook/react', 'angular/angular', 'withastro/astro', 'pnpm/pnpm',
  'prisma/prisma', 'vitejs/vite', 'sveltejs/svelte', 'vuejs/core', 'remix-run/react-router', 'trpc/trpc', 'TanStack/query', 'microsoft/TypeScript',
  'langchain-ai/langchain', 'huggingface/transformers', 'astral-sh/uv', 'astral-sh/ruff', 'pydantic/pydantic', 'fastapi/fastapi', 'django/django',
  'psf/requests', 'pallets/flask', 'scikit-learn/scikit-learn', 'pandas-dev/pandas', 'python-poetry/poetry', 'encode/httpx', 'tiangolo/sqlmodel',
  'tokio-rs/tokio', 'rust-lang/cargo', 'serde-rs/serde', 'BurntSushi/ripgrep', 'gin-gonic/gin', 'golang/go', 'kubernetes/kubernetes', 'hashicorp/terraform',
  'spring-projects/spring-boot', 'square/okhttp', 'JetBrains/kotlin', 'laravel/laravel', 'laravel/framework', 'symfony/symfony', 'composer/composer',
  'rails/rails', 'Homebrew/brew', 'jekyll/jekyll', 'dotnet/aspnetcore', 'dotnet/runtime', 'denoland/deno', 'oven-sh/bun', 'biomejs/biome',
  'modelcontextprotocol/servers', 'anthropics/anthropic-sdk-python', 'openai/openai-node', 'microsoft/playwright', 'storybookjs/storybook',
];
const SKIP = /awesome|interview|roadmap|free-programming|books|tutorial|cheat|public-apis|system-design|leetcode|algorithm|course|learn|guide|resume|papers|-list$|hello-world|30-days|daily|questions|examples?$|javascript-questions|You-Dont-Know/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.github.com${url}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'pinright-fp-bench' },
    });
    // The search API has its own small bucket (30 a minute); only the core one needs a reserve.
    const left = Number(res.headers.get('x-ratelimit-limit') ?? '0') > 100 ? Number(res.headers.get('x-ratelimit-remaining') ?? '100') : 100;
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0') * 1000;
      const wait = Math.max(5_000, Math.min(reset - Date.now() + 1_000, 15 * 60_000));
      console.error(`rate limited on ${url}; waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      continue;
    }
    if (left < 30) await sleep(60_000);
    if (!res.ok) return undefined;
    return res.json();
  }
  return undefined;
}

async function raw(repo: string, ref: string, file: string): Promise<string | undefined> {
  const enc = file.split('/').map(encodeURIComponent).join('/');
  for (const url of [`https://raw.githubusercontent.com/${repo}/${ref}/${enc}`, `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${enc}`]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'pinright-fp-bench' } });
      if (res.ok) return await res.text();
    } catch {
      // next source
    }
  }
  return undefined;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, k: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const k = next++;
        results[k] = await fn(items[k], k);
      }
    }),
  );
  return results;
}

interface Repo {
  full: string;
  branch: string;
  language: string;
  stars: number;
}

async function pickRepos(): Promise<Repo[]> {
  const file = path.join(out, 'repos.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const picked = new Map<string, Repo>();
  for (const lang of LANGUAGES) {
    const q = encodeURIComponent(`language:"${lang}" stars:>3000 archived:false fork:false pushed:>2026-06-01`);
    const r = (await api(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=60`)) as { items?: any[] } | undefined;
    let n = 0;
    for (const it of r?.items ?? []) {
      if (n >= perLanguage) break;
      if (SKIP.test(it.full_name) || SKIP.test(it.description ?? '')) continue;
      if (picked.has(it.full_name.toLowerCase())) continue;
      picked.set(it.full_name.toLowerCase(), { full: it.full_name, branch: it.default_branch, language: lang, stars: it.stargazers_count });
      n++;
    }
    await sleep(2_500); // the search API allows 30 requests a minute
  }
  for (const full of EXTRA) {
    if (picked.has(full.toLowerCase())) continue;
    const it = (await api(`/repos/${full}`)) as any;
    if (it?.default_branch) picked.set(full.toLowerCase(), { full: it.full_name, branch: it.default_branch, language: it.language ?? '?', stars: it.stargazers_count });
  }
  const list = [...picked.values()];
  fs.writeFileSync(file, JSON.stringify(list, null, 1));
  return list;
}

/** Which files of a tree to download, with a cap per kind. */
const WANT: [string, RegExp, number][] = [
  ['workflow', /^\.github\/workflows\/[^/]+\.ya?ml$/i, 40],
  ['dockerfile', /(^|\/)(Dockerfile|[^/]+\.Dockerfile|Dockerfile\.[\w.-]+)$/, 8],
  ['package', /^([^/]+\/){0,3}package\.json$/, 30],
  ['make', /^([^/]+\/){0,1}(GNUmakefile|makefile|Makefile|justfile|Justfile|\.justfile)$/, 6],
  ['readme', /^(README|CONTRIBUTING|\.github\/CONTRIBUTING|docs\/CONTRIBUTING|INSTALL|DEVELOPMENT|HACKING)(\.md|\.markdown|\.rst)?$/i, 6],
  ['requirements', /^([^/]+\/){0,3}(requirements[^/]*\.(txt|in)|[^/]*-requirements\.(txt|in)|requirements\/[^/]+\.(txt|in)|constraints[^/]*\.txt)$/i, 20],
  ['manifest', /^([^/]+\/){0,1}(pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|deno\.jsonc?|pnpm-workspace\.yaml)$/, 12],
  ['gradle-sibling', /^(gradle\/libs\.versions\.toml|gradle\.properties)$/, 2],
  ['script', /^([^/]+\/){0,2}[^/]+\.(sh|bash|ps1)$/, 30],
];

interface Entry {
  id: string;
  kind: 'command' | 'write';
  repo: string;
  /** Where it came from: workflow, dockerfile, npm-script, make, readme, manifest. */
  source: string;
  path: string;
  /** Directory the command runs in, relative to the repository root. */
  cwd: string;
  command?: string;
  /** For writes: the file (relative to the case dir) and the case dir under wcases/. */
  file?: string;
  caseDir?: string;
  templated?: boolean;
}

const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|(?<=(token|password|secret|apikey|api_key)[=:]\s*)[A-Za-z0-9+/_-]{20,})/gi;
const redact = (s: string) => s.replace(SECRET, '<REDACTED>');

/** `run:` values of a workflow, with the step's working-directory when it has one. */
function workflowRuns(text: string): { command: string; cwd: string }[] {
  const lines = text.split(/\r?\n/);
  const res: { command: string; cwd: string }[] = [];
  const indent = (l: string) => l.length - l.trimStart().length;
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2]?.length ?? 0);
    let value = m[3].trim();
    let command: string;
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) {
      const folded = value.startsWith('>');
      const body: string[] = [];
      let j = k + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') {
          body.push('');
          continue;
        }
        if (indent(lines[j]) <= keyIndent) break;
        body.push(lines[j]);
      }
      const min = Math.min(...body.filter((l) => l.trim()).map(indent));
      const dedented = body.map((l) => l.slice(Number.isFinite(min) ? min : 0));
      command = (folded ? dedented.join(' ') : dedented.join('\n')).trim();
      k = j - 1;
    } else {
      const quotedValue = /^["']/.test(value);
      if (quotedValue) {
        const end = value.lastIndexOf(value[0]);
        const quoted = value.slice(0, end > 0 ? end + 1 : undefined);
        // YAML double quotes take JSON-like escapes ("a\nb"); single quotes double the quote.
        try {
          value = quoted.startsWith('"') ? JSON.parse(quoted) : quoted.slice(1, -1).replace(/''/g, "'");
        } catch {
          value = quoted.slice(1, -1);
        }
      }
      command = (quotedValue ? value : value.replace(/\s+#.*$/, '')).trim();
    }
    if (!command) continue;
    // The step around this key: back to its "- " and forward until the next step.
    let start = k;
    while (start > 0 && !/^\s*-\s/.test(lines[start]) && indent(lines[start]) >= keyIndent - 2) start--;
    const stepIndent = indent(lines[start]);
    let cwd = '.';
    for (let j = start; j < lines.length && j < start + 60; j++) {
      if (j > start && /^\s*-\s/.test(lines[j]) && indent(lines[j]) <= stepIndent) break;
      const wd = lines[j].match(/^\s*working-directory:\s*["']?([^"'#\s]+)/);
      if (wd) cwd = wd[1];
    }
    res.push({ command, cwd: /\$\{\{/.test(cwd) ? '.' : cwd.replace(/^\.\//, '') || '.' });
  }
  return res;
}

function dockerRuns(text: string): string[] {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const res: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(/^\s*RUN\s+(.*)$/i);
    if (!m) continue;
    let c = m[1].replace(/^(--[\w-]+=\S+\s+)+/, '').trim();
    if (c.startsWith('[')) {
      try {
        c = (JSON.parse(c) as string[]).join(' ');
      } catch {
        // keep as is
      }
    }
    // RUN with a heredoc (cat <<'EOF' > file, or RUN <<EOF): the body follows, up to the delimiter.
    const here = /<<-?\s*["']?(\w+)["']?/.exec(c);
    if (here) {
      const body: string[] = [];
      for (k++; k < lines.length && lines[k].trim() !== here[1]; k++) body.push(lines[k]);
      c = c.startsWith('<<') ? body.join('\n') : `${c}\n${body.join('\n')}\n${here[1]}`;
      if (c.trim()) res.push(c);
      continue;
    }
    if (c) res.push(c.replace(/\s+/g, ' '));
  }
  return res;
}

const SHELL_LANGS = /^(bash|sh|shell|console|zsh|shell-session|shellsession|sh-session|powershell|ps1|pwsh|cmd|bat|terminal|)$/i;
const COMMANDISH = /^(sudo\s+)?(npm|npx|pnpm|pnpx|yarn|bun|bunx|deno|node|pip3?|pipx|uv|uvx|python3?|py|poetry|pdm|pipenv|conda|mamba|cargo|rustup|go|gem|bundle|composer|php|dotnet|nuget|mvn|\.\/mvnw|gradle|\.\/gradlew|make|just|brew|apt(-get)?|docker|git|curl|wget|cd|export|source|\.|sh|bash|corepack|rake|rails|ruby|java|kotlin|swift|cmake|nix|winget|choco|scoop|helm|kubectl)\b/;

/** Command lines in the shell code blocks of a markdown file. */
function markdownCommands(text: string): string[] {
  const res: string[] = [];
  const blocks = text.matchAll(/^\s*(```|~~~)\s*([\w+-]*)[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm);
  for (const b of blocks) {
    const lang = b[2] ?? '';
    if (!SHELL_LANGS.test(lang)) continue;
    const prompted = /console|session|terminal/i.test(lang);
    const body = b[3].replace(/\\\r?\n\s*/g, ' ');
    for (let line of body.split(/\r?\n/)) {
      line = line.trim();
      const p = line.match(/^(\$|%|>|PS[^>]*>|[A-Z]:\\[^>]*>)\s+(.*)$/);
      if (p) line = p[2];
      else if (prompted) continue;
      if (!line || line.startsWith('#')) continue;
      if (!lang && !COMMANDISH.test(line)) continue;
      if (!COMMANDISH.test(line) && !/^[\w./-]+(\s|$)/.test(line)) continue;
      res.push(line);
    }
  }
  return res;
}

/** Targets of a Makefile and recipes of a justfile that an agent would run. */
function makeTargets(text: string, just: boolean): string[] {
  const res = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) || /^\s*(export|include|ifeq|ifneq|ifdef|ifndef|else|endif|define|set|alias|import|mod)\b/.test(line)) continue;
    const m = just ? line.match(/^@?([A-Za-z_][\w-]*)(?:\s+[^:=]*)?:(?!=)/) : line.match(/^([A-Za-z][\w.-]*)\s*::?(?!=)/);
    if (m && !m[1].includes('%') && !m[1].startsWith('.')) res.add(m[1]);
  }
  return [...res].slice(0, 40);
}

let binCache: Record<string, string[]> | undefined;

async function npmBins(names: string[], cacheFile: string): Promise<Map<string, string[]>> {
  binCache ??= fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const cache = binCache as Record<string, string[]>;
  const todo = names.filter((n) => !(n in cache));
  // Gently: npm's CDN answered a burst with a temporary ban (Cloudflare 1015). Failures are not cached.
  await pool(todo, 6, async (name) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // jsDelivr serves the latest package.json; the registry itself is left to the hook's own lookups.
        const res = await fetch(`https://cdn.jsdelivr.net/npm/${name}/package.json`, { headers: { 'user-agent': 'pinright-fp-bench' } });
        if (res.status === 404) {
          cache[name] = [];
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { bin?: string | Record<string, string> };
        cache[name] = typeof j.bin === 'string' ? [name.replace(/^@[^/]+\//, '')] : Object.keys(j.bin ?? {});
        return;
      } catch {
        await sleep(5_000 * (attempt + 1));
      }
    }
  });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return new Map(Object.entries(cache));
}

async function collectRepo(repo: Repo): Promise<Entry[]> {
  const slug = repo.full.replace('/', '__');
  const root = path.join(out, 'repos', slug);
  const metaFile = path.join(root, '.fp-meta.json');
  let files: { path: string; kind: string }[];
  if (fs.existsSync(metaFile)) files = JSON.parse(fs.readFileSync(metaFile, 'utf8')).files;
  else {
    const tree = (await api(`/repos/${repo.full}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`)) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean } | undefined;
    const blobs = (tree?.tree ?? []).filter((t) => t.type === 'blob' && (t.size ?? 0) < 400_000 && !/(^|\/)(node_modules|vendor|third_party|testdata|fixtures?|__tests__|test|tests|examples?)\//i.test(t.path));
    if (tree?.truncated && !blobs.some((b) => b.path.startsWith('.github/workflows/'))) {
      const wf = (await api(`/repos/${repo.full}/contents/.github/workflows?ref=${encodeURIComponent(repo.branch)}`)) as { path: string; type: string }[] | undefined;
      for (const w of wf ?? []) if (w.type === 'file') blobs.push({ path: w.path, type: 'blob' });
    }
    files = [];
    for (const [kind, re, cap] of WANT) {
      const hits = blobs.filter((b) => re.test(b.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length).slice(0, cap);
      for (const h of hits) files.push({ path: h.path, kind });
    }
    await pool(files, 8, async (f) => {
      const text = await raw(repo.full, repo.branch, f.path);
      if (text === undefined) return;
      const dest = path.join(root, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    });
    files = files.filter((f) => fs.existsSync(path.join(root, ...f.path.split('/'))));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ repo, files }, null, 1));
  }
  const read = (p: string) => fs.readFileSync(path.join(root, ...p.split('/')), 'utf8');
  const entries: Entry[] = [];
  const add = (e: Omit<Entry, 'id' | 'repo' | 'kind'> & { kind?: Entry['kind'] }) => {
    const command = e.command === undefined ? undefined : redact(e.command);
    entries.push({ kind: 'command', ...e, command, repo: repo.full, id: `${slug}:${entries.length}`, ...(command && /\$\{\{/.test(command) ? { templated: true } : {}) });
  };
  for (const f of files) {
    const dir = path.posix.dirname(f.path);
    let text: string;
    try {
      text = read(f.path);
    } catch {
      continue;
    }
    if (f.kind === 'workflow') for (const r of workflowRuns(text)) add({ source: 'workflow', path: f.path, cwd: r.cwd, command: r.command });
    if (f.kind === 'dockerfile') for (const c of dockerRuns(text)) add({ source: 'dockerfile', path: f.path, cwd: dir, command: c });
    if (f.kind === 'readme') for (const c of markdownCommands(text)) add({ source: 'readme', path: f.path, cwd: '.', command: c });
    if (f.kind === 'make') {
      const just = /justfile$/i.test(f.path);
      for (const t of makeTargets(text, just)) add({ source: 'make', path: f.path, cwd: dir, command: `${just ? 'just' : 'make'} ${t}` });
    }
    if (f.kind === 'package') {
      try {
        const pj = JSON.parse(text);
        for (const name of Object.keys(pj.scripts ?? {}).slice(0, 60)) add({ source: 'npm-script', path: f.path, cwd: dir, command: `npm run ${name}` });
        add({ source: 'npm-script', path: f.path, cwd: dir, command: 'npm install' });
      } catch {
        // not JSON
      }
    }
  }
  // npm bins of the declared dependencies, as `npm ci` would leave them in node_modules/.bin.
  const deps = new Set<string>();
  for (const f of files.filter((x) => x.kind === 'package')) {
    try {
      const pj = JSON.parse(read(f.path));
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const n of Object.keys(pj[k] ?? {})) deps.add(n);
    } catch {
      // skip
    }
  }
  if (deps.size) {
    const bins = await npmBins([...deps].filter((n) => /^(@[\w.-]+\/)?[\w.-]+$/.test(n)), path.join(out, 'npm-bins.json'));
    const binDir = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const n of deps) for (const b of bins.get(n) ?? []) if (/^[\w.-]+$/.test(b)) fs.writeFileSync(path.join(binDir, b), '');
  }
  // Manifest writes: the version before the last commit that touched it, then the current one.
  const manifests = files.filter((f) => f.kind === 'manifest' || (f.kind === 'package' && f.path.split('/').length <= 2) || (f.kind === 'requirements' && f.path.split('/').length <= 2)).slice(0, 6);
  for (const m of manifests) {
    const caseDir = path.join(out, 'wcases', slug, m.path.replace(/[/\\]/g, '__'));
    const oldFile = path.join(caseDir, ...m.path.split('/'));
    if (!fs.existsSync(path.join(caseDir, '.fp-new'))) {
      const commits = (await api(`/repos/${repo.full}/commits?path=${encodeURIComponent(m.path)}&sha=${encodeURIComponent(repo.branch)}&per_page=2`)) as { sha: string }[] | undefined;
      const prev = commits?.[1]?.sha;
      if (!prev) continue;
      const old = await raw(repo.full, prev, m.path);
      if (old === undefined) continue;
      fs.mkdirSync(path.dirname(oldFile), { recursive: true });
      fs.writeFileSync(oldFile, old);
      fs.writeFileSync(path.join(caseDir, '.fp-new'), read(m.path));
      // What a Gradle script resolves from its neighbours.
      for (const s of ['gradle/libs.versions.toml', 'gradle.properties']) {
        if (/\.gradle(\.kts)?$/.test(m.path) && fs.existsSync(path.join(root, ...s.split('/')))) {
          const dest = path.join(caseDir, ...s.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(root, ...s.split('/')), dest);
        }
      }
    }
    add({ kind: 'write', source: 'manifest', path: m.path, cwd: '.', file: m.path, caseDir: path.relative(out, caseDir) });
  }
  return entries;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const repos = await pickRepos();
  console.error(`${repos.length} repositories`);
  const all = await pool(repos, 4, async (r, k) => {
    try {
      const e = await collectRepo(r);
      console.error(`[${k + 1}/${repos.length}] ${r.full}: ${e.length}`);
      return e;
    } catch (err) {
      console.error(`[${k + 1}/${repos.length}] ${r.full}: failed (${(err as Error).message})`);
      return [];
    }
  });
  const entries = all.flat();
  fs.writeFileSync(path.join(out, 'corpus.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const distinct = new Set(entries.filter((e) => e.kind === 'command').map((e) => e.command)).size;
  console.error(`${entries.length} entries, ${distinct} distinct commands, ${entries.filter((e) => e.kind === 'write').length} manifest writes`);
}

void main();
