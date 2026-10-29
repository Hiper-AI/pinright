/** The package ecosystems we can give a verdict for, and how each upstream names them. */
export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'nuget' | 'rubygems' | 'composer';

export const ECOSYSTEMS: readonly Ecosystem[] = [
  'npm',
  'pypi',
  'cargo',
  'go',
  'maven',
  'nuget',
  'rubygems',
  'composer',
];

/** deps.dev does not index Packagist: composer versions come from repo.packagist.org (see composer/packagist.ts). */
export const NO_DEPS_DEV: readonly Ecosystem[] = ['composer'];

const DEPS_DEV_SYSTEM: Record<Ecosystem, string> = {
  npm: 'npm',
  pypi: 'pypi',
  cargo: 'cargo',
  go: 'go',
  maven: 'maven',
  nuget: 'nuget',
  rubygems: 'rubygems',
  composer: 'packagist',
};

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  rubygems: 'RubyGems',
  composer: 'Packagist',
};

const FROM_DEPS_DEV: Record<string, Ecosystem> = {
  NPM: 'npm',
  PYPI: 'pypi',
  CARGO: 'cargo',
  GO: 'go',
  MAVEN: 'maven',
  NUGET: 'nuget',
  RUBYGEMS: 'rubygems',
};

export function toDepsDevSystem(eco: Ecosystem): string {
  return DEPS_DEV_SYSTEM[eco];
}

export function toOsvEcosystem(eco: Ecosystem): string {
  return OSV_ECOSYSTEM[eco];
}

export function fromDepsDevSystem(system: string): Ecosystem | undefined {
  return FROM_DEPS_DEV[system.toUpperCase()];
}

/** Accepts the names people type ("node", "python", "rust", "crates.io") and normalizes them. */
export function parseEcosystem(raw: string | undefined): Ecosystem | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const aliases: Record<string, Ecosystem> = {
    npm: 'npm',
    node: 'npm',
    nodejs: 'npm',
    javascript: 'npm',
    typescript: 'npm',
    js: 'npm',
    ts: 'npm',
    pypi: 'pypi',
    pip: 'pypi',
    python: 'pypi',
    py: 'pypi',
    cargo: 'cargo',
    crates: 'cargo',
    'crates.io': 'cargo',
    rust: 'cargo',
    go: 'go',
    golang: 'go',
    maven: 'maven',
    java: 'maven',
    kotlin: 'maven',
    nuget: 'nuget',
    dotnet: 'nuget',
    csharp: 'nuget',
    'c#': 'nuget',
    rubygems: 'rubygems',
    gem: 'rubygems',
    gems: 'rubygems',
    ruby: 'rubygems',
    composer: 'composer',
    packagist: 'composer',
    php: 'composer',
  };
  return aliases[s];
}

/** The install command an agent would run, used in the security notice. */
export function installCommand(eco: Ecosystem, name: string, version: string): string {
  switch (eco) {
    case 'npm':
      return `npm install ${name}@${version}`;
    case 'pypi':
      return `pip install "${name}==${version}"`;
    case 'cargo':
      return `cargo add ${name}@${version}`;
    case 'go':
      return `go get ${name}@v${version.replace(/^v/, '')}`;
    case 'maven':
      return `${name}:${version} (Maven coordinates groupId:artifactId:version)`;
    case 'nuget':
      return `dotnet add package ${name} --version ${version}`;
    case 'rubygems':
      return `gem install ${name} -v ${version}`;
    case 'composer':
      return `composer require ${name}:${version}`;
  }
}
