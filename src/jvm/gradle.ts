/**
 * Gradle: build.gradle (Groovy), build.gradle.kts (Kotlin), the version catalog
 * gradle/libs.versions.toml and gradle.lockfile. Line-based readers: a build
 * script is code, so anything computed at runtime is skipped rather than guessed.
 *
 * Understood: "g:a:v" string notation (with or without parentheses, inside
 * platform()/enforcedPlatform()), map notation (group/name/version), $var and
 * ${var} from simple assignments in the same file or gradle.properties, and
 * libs.x.y / libs.bundles.x catalog references.
 */
import type { ParsedTree, TreePackage } from '../tree/lockfiles.js';
import type { JvmDependency } from './maven.js';

const CONF = String.raw`\b(\w*(?:implementation|Implementation|api|Api|compileOnly|CompileOnly|runtimeOnly|RuntimeOnly|compile|Compile|runtime|annotationProcessor|AnnotationProcessor|kapt|Kapt|ksp|Ksp|classpath))`;
const STRING_DEP = new RegExp(`${CONF}\\s*\\(?\\s*(?:(?:platform|enforcedPlatform)\\s*\\(\\s*)?["']([^"'\\s]+:[^"'\\s]+)["']`, 'g');
const MAP_DEP = new RegExp(
  `${CONF}\\s*\\(?\\s*group\\s*[:=]\\s*["']([^"']+)["']\\s*,\\s*name\\s*[:=]\\s*["']([^"']+)["']\\s*(?:,\\s*version\\s*[:=]\\s*["']([^"']+)["'])?`,
  'g',
);
const CATALOG_DEP = new RegExp(`${CONF}\\s*\\(?\\s*(?:(?:platform|enforcedPlatform)\\s*\\(\\s*)?libs\\.([A-Za-z0-9_.]+)`, 'g');

const isTestConf = (c: string) => /^(test|androidTest|testFixtures)/.test(c);

/** Accessor form of a catalog alias: "spring-core" and "spring_core" are both libs.spring.core. */
export const catalogKey = (alias: string) => alias.replace(/[-_]/g, '.').toLowerCase();

/** Simple string assignments a build script interpolates: val x = "1", def x = '1', ext.x = '1', extra["x"] = "1", set("x", "1"). */
function variables(content: string, gradleProperties?: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of (gradleProperties ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(\S.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) vars.set(m[1], m[2]);
  }
  for (const m of content.matchAll(/^\s*(?:val|var|def|ext\.|project\.ext\.)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([^"'$]+)["']/gm)) vars.set(m[1], m[2]);
  for (const m of content.matchAll(/extra\[\s*"([^"]+)"\s*\]\s*=\s*"([^"$]+)"/g)) vars.set(m[1], m[2]);
  for (const m of content.matchAll(/\bset\(\s*["']([^"']+)["']\s*,\s*["']([^"'$]+)["']\s*\)/g)) vars.set(m[1], m[2]);
  return vars;
}

function interpolate(s: string, vars: Map<string, string>): string | undefined {
  const out = s.replace(/\$\{([A-Za-z0-9_.]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a?: string, b?: string) => vars.get((a ?? b) as string) ?? all);
  return out.includes('$') ? undefined : out;
}

/** "g:a:v", "g:a:v:classifier", "g:a:v@aar" -> coordinates; no version -> undefined spec. */
function coordinates(s: string): { name: string; spec?: string } | undefined {
  const [g, a, v] = s.replace(/@[A-Za-z0-9]+$/, '').split(':');
  if (!g || !a) return undefined;
  return { name: `${g}:${a}`, spec: v || undefined };
}

export interface Catalog {
  libraries: Map<string, JvmDependency>;
  bundles: Map<string, string[]>;
}

function tomlSection(content: string, name: string): string[] {
  const m = content.match(new RegExp(`^\\[${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm'));
  return m ? m[1].split(/\r?\n/) : [];
}

/** gradle/libs.versions.toml: [versions], [libraries] and [bundles]. Libraries without a version (BOM-managed) are left out. */
export function parseCatalog(content: string): Catalog {
  const versions = new Map<string, string>();
  for (const line of tomlSection(content, 'versions')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{([^}]*)\})/);
    if (!m) continue;
    const v = m[2] ?? m[3]?.match(/(?:strictly|require|prefer)\s*=\s*"([^"]+)"/)?.[1];
    if (v) versions.set(m[1], v);
  }
  const libraries = new Map<string, JvmDependency>();
  for (const line of tomlSection(content, 'libraries')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{(.*)\})\s*(?:#.*)?$/);
    if (!m) continue;
    let name: string | undefined;
    let spec: string | undefined;
    if (m[2]) ({ name, spec } = coordinates(m[2]) ?? {});
    else {
      const body = m[3];
      const module = body.match(/\bmodule\s*=\s*"([^"]+)"/)?.[1];
      const group = body.match(/\bgroup\s*=\s*"([^"]+)"/)?.[1];
      const artifact = body.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
      name = module ?? (group && artifact ? `${group}:${artifact}` : undefined);
      const ref = body.match(/version\.ref\s*=\s*"([^"]+)"/)?.[1] ?? body.match(/version\s*=\s*\{\s*ref\s*=\s*"([^"]+)"/)?.[1];
      spec = ref ? versions.get(ref) : (body.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? body.match(/version\s*=\s*\{[^}]*?(?:strictly|require|prefer)\s*=\s*"([^"]+)"/)?.[1]);
    }
    if (name && spec) libraries.set(catalogKey(m[1]), { name, spec });
  }
  const bundles = new Map<string, string[]>();
  for (const line of tomlSection(content, 'bundles')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\[([^\]]*)\]/);
    if (m) bundles.set(catalogKey(m[1]), [...m[2].matchAll(/"([^"]+)"/g)].map((x) => catalogKey(x[1])));
  }
  return { libraries, bundles };
}

export function parseVersionCatalog(file: string, content: string): ParsedTree {
  return { ecosystem: 'maven', kind: 'manifest', file, packages: [], declared: [...parseCatalog(content).libraries.values()] };
}

/** Dependencies of a build.gradle / build.gradle.kts. `siblings` may carry libs.versions.toml and gradle.properties. */
export function gradleDependencies(content: string, siblings: Record<string, string> = {}): JvmDependency[] {
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const vars = variables(code, siblings['gradle.properties']);
  const catalog = siblings['libs.versions.toml'] ? parseCatalog(siblings['libs.versions.toml']) : undefined;
  const out: JvmDependency[] = [];
  const push = (conf: string, name: string, spec: string | undefined) => {
    if (!spec) return; // managed by a platform/BOM: nothing to check on its own
    const v = interpolate(spec, vars);
    if (v) out.push({ name, spec: v, dev: isTestConf(conf) || undefined });
  };
  for (const m of code.matchAll(STRING_DEP)) {
    const s = interpolate(m[2], vars);
    const coord = s ? coordinates(s) : undefined;
    if (coord) push(m[1], coord.name, coord.spec);
  }
  for (const m of code.matchAll(MAP_DEP)) push(m[1], `${m[2]}:${m[3]}`, m[4]);
  if (catalog) {
    for (const m of code.matchAll(CATALOG_DEP)) {
      const key = m[2].replace(/\.get\(\)$/, '').toLowerCase();
      if (key.startsWith('versions.') || key.startsWith('plugins.')) continue;
      const keys = key.startsWith('bundles.') ? catalog.bundles.get(key.slice('bundles.'.length)) ?? [] : [key];
      for (const k of keys) {
        const lib = catalog.libraries.get(k);
        if (lib) push(m[1], lib.name, lib.spec);
      }
    }
  }
  return out;
}

export function parseGradleBuild(file: string, content: string, siblings: Record<string, string> = {}): ParsedTree {
  return { ecosystem: 'maven', kind: 'manifest', file, packages: [], declared: gradleDependencies(content, siblings) };
}

/** gradle.lockfile: "group:artifact:version=conf1,conf2". The build script, when given, says which are direct. */
export function parseGradleLockfile(file: string, content: string, siblings: Record<string, string> = {}): ParsedTree {
  const build = siblings['build.gradle.kts'] ?? siblings['build.gradle'];
  const direct = build ? new Set(gradleDependencies(build, siblings).map((d) => d.name)) : undefined;
  const seen = new Map<string, TreePackage>();
  for (const line of content.split(/\r?\n/)) {
    const m = line.trim().match(/^([^#:\s]+):([^:\s]+):([^=\s]+)=(.*)$/);
    if (!m) continue;
    const confs = m[4].split(',').map((c) => c.trim()).filter(Boolean);
    const name = `${m[1]}:${m[2]}`;
    const key = `${name}@${m[3]}`;
    if (seen.has(key)) continue;
    seen.set(key, { name, version: m[3], direct: direct ? direct.has(name) : undefined, dev: confs.length > 0 && confs.every(isTestConf) });
  }
  return { ecosystem: 'maven', kind: 'lockfile', file, packages: [...seen.values()] };
}
