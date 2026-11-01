/**
 * False positives found by replaying public real-world commands through the hook
 * (bench/fp: GitHub Actions steps, Dockerfiles, package.json scripts, Makefiles and
 * README install blocks of popular repositories). Each case is an everyday command
 * that used to ask or block, next to the attack it must still catch.
 *
 * Nothing here installs anything: the commands are strings, the files are maps.
 */
import { describe, expect, it, vi } from 'vitest';
import { fromCommand, fromFileWrite } from '../src/hook/intent.js';
import { type DepIntent } from '../src/hook/spec.js';

process.env.PINRIGHT_NO_CACHE = '1';

/** The registries, for the decision-level cases: the end of a URL -> its JSON; anything else is a 404. */
const fixtures = new Map<string, unknown>();
vi.mock('../src/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
  return {
    ...actual,
    getJson: vi.fn(async (url: string) => {
      const key = [...fixtures.keys()].find((k) => url.endsWith(k));
      if (!key) throw new actual.HttpError(404, url);
      return fixtures.get(key);
    }),
  };
});

/** "npm:x 1.0 (exec)" for a lookup, "?npm" for unverifiable (policy), "~npm" for a note. */
const show = (i: DepIntent) =>
  i.unverifiable ? `${i.unverifiable.level === 'note' ? '~' : i.unverifiable.level === 'guard' ? '!' : '?'}${i.ecosystem}` : `${i.ecosystem}:${i.name}${i.spec ? ` ${i.spec}` : ''}${i.executes ? ' (exec)' : ''}`;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Z]:/, '');
const cmd = (c: string, files: Record<string, string> = {}) => fromCommand(c, '/p', (p) => files[norm(p)]).map(show);
const write = (f: string, next: string | undefined, old?: string) => fromFileWrite(f, next, old).map(show);

describe('make variables are make, not command substitutions', () => {
  const makefile = [
    'PYTHON ?= python3',
    'VENV := .venv',
    'PIP = $(VENV)/bin/pip',
    'PKG ?= reqeusts',
    '.PHONY: test install dev evil',
    'test:',
    '\t$(PYTHON) -m pytest -q',
    'install:',
    '\t$(MAKE) dev',
    'dev:',
    '\t$(PIP) install -e .',
    'evil:',
    '\t$(PIP) install $(PKG)',
    'opaque:',
    '\t$(UNSET) install x',
    'shellvar:',
    '\tfor f in *.txt; do echo $$f; done',
    '',
  ].join('\n');

  it('expands the variables the Makefile sets, as make would', () => {
    expect(cmd('make test', { '/p/Makefile': makefile })).toEqual([]);
    expect(cmd('make install', { '/p/Makefile': makefile })).toEqual([]);
    expect(cmd('make shellvar', { '/p/Makefile': makefile })).toEqual([]);
  });

  it('still reads the install behind a variable, and the command line overrides it', () => {
    expect(cmd('make evil', { '/p/Makefile': makefile })).toEqual(['pypi:reqeusts']);
    expect(cmd('make evil PKG=expresss-py', { '/p/Makefile': makefile })).toEqual(['pypi:expresss-py']);
  });

  it('a variable the Makefile does not set stays unverifiable', () => {
    expect(cmd('make opaque', { '/p/Makefile': makefile })).toEqual(['?npm']);
  });
});

describe('an interpreter in a variable', () => {
  it.each([
    ['$PYTHON -m pytest tests/', []],
    ['"${PYTHON}" -m mypy src', []],
    ['$(VENV)/bin/python -u -m unittest discover', []],
    ['$PYTHON -m pip install reqeusts', ['pypi:reqeusts']],
    ['$PY -m pip install -r reqs.txt', ['pypi:reqeusts']],
    // Not an interpreter: a git commit message stays a message.
    ['$GIT commit -m "npm i expresss"', []],
    ['$NPM install expresss', ['?npm']],
  ])('%s', (c, want) => expect(cmd(c, { '/p/reqs.txt': 'reqeusts\n' })).toEqual(want));
});

describe('a known program in a folder that comes from a variable', () => {
  it.each([
    ['$VCPKG_ROOT/vcpkg install libvpx opus', []],
    ['"${RUNNER_TEMP}/venv/bin/python" -m twine check dist/*', []],
    ['"$VENV/bin/pip" install reqeusts', ['pypi:reqeusts']],
    ['$(dirname "$0")/npm i expresss', ['npm:expresss']],
    // The program itself unknown: still unverifiable.
    ['$TOOL install expresss', ['?npm']],
    ['"$(which npm)" install expresss', ['?npm']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('PowerShell loops', () => {
  it.each([
    ["foreach ($path in @('a.ps1', 'b.ps1')) { Write-Host $path }", []],
    ['foreach ($msix in Get-ChildItem -Path $dir -Filter *.msix) { Remove-Item $msix }', []],
    // The loop body is still read.
    ['foreach ($p in $pkgs) { npm i $p }', ['?npm']],
    ["foreach ($p in @('x')) { npm i expresss }", ['npm:expresss']],
    ['$envLines = foreach ($key in $keys) { "$key=1" }', []],
    // Outside a foreach header, "$X in pkg" is still a program in a variable (bash runs it).
    ['$NPM in expresss', ['?npm']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe("options after the command belong to the command, not to the package manager", () => {
  const local = { '/p/node_modules/.bin/tsc': '', '/p/node_modules/.bin/vsce': '' };
  it.each([
    // -p is npm's --package, -c its --call, -f uv's --find-links: but not after the bin.
    ['npx tsc -p tsconfig.build.json', []],
    ['bun x tsc --noEmit -p scripts/build/tsconfig.json', []],
    ['npx vsce publish -p $VSCE_TOKEN', []],
    ['uv run --only-group docs mkdocs build --strict -f mkdocs.yml', []],
    ['uv run griffe dump -f -d google -o/dev/null src', []],
    ['uvx ruff check --index-url https://example.com/simple', ['pypi:ruff (exec)']],
    ['pipx run build --index-url https://example.com/simple', ['pypi:build (exec)']],
    ['pnpm dlx audit-ci@^7 --registry http://localhost:4873', ['npm:audit-ci ^7 (exec)']],
    // Before the command they are still the package manager's.
    ['npx -p expresss tsc', ['npm:expresss (exec)']],
    ['uvx --index-url https://evil.example/simple ruff', ['?pypi', 'pypi:ruff (exec)']],
    ['uv run --with reqeusts pytest -f x', ['pypi:reqeusts']],
    // npm exec parses every option (npm docs), so --package after the bin still installs it.
    ['npm exec tsc --package=expresss', ['npm:expresss (exec)']],
  ])('%s', (c, want) => expect(cmd(c, local)).toEqual(want));
});

describe('paths are local, also with a variable inside', () => {
  it.each([
    ['uv pip install -e sdk/python', []],
    ['python -m pip install --no-deps -e packages/sdk/python', []],
    ['pip install backend\\core', []],
    ['npm install --global --prefix "${prefix}" "./${tarball}"', []],
    ['pip install /dist/"${PACKAGE_NAME}"-*.tar.gz --force-reinstall', []],
    ['pip install dist/"${PACKAGE_NAME}"-*.whl', []],
    ['pip install -e .[$extra]', []],
    ['npm i ~/build/$name.tgz', []],
    // A variable that can be anything is still unverifiable; so is a GitHub shorthand with one.
    ['pip install "$wheel"', ['?pypi']],
    ['pip install $GITHUB_WORKSPACE/dist/*.whl', ['?pypi']],
    ['npm i user/$repo', ['?npm']],
    ['pip install "reqeusts==$V"', ['?pypi']],
    ['pip install "git+https://${HOST}/x.git"', ['?pypi']],
    // A plain name is still a registry package.
    ['pip install reqeusts', ['pypi:reqeusts']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('--ignore-scripts', () => {
  const files = { '/p/package.json': JSON.stringify({ scripts: { preinstall: 'npx only-allow pnpm', postinstall: 'npm i expresss' } }) };
  it('an install that ignores scripts does not run the lifecycle scripts', () => {
    expect(cmd('pnpm install --frozen-lockfile --ignore-scripts', files)).toEqual([]);
    expect(cmd('npm ci --ignore-scripts', files)).toEqual([]);
    expect(cmd('yarn --ignore-scripts', files)).toEqual([]);
  });
  it('without it, or with --ignore-scripts=false, they are read', () => {
    expect(cmd('npm ci', files)).toEqual(['npm:only-allow (exec)', 'npm:expresss']);
    expect(cmd('npm ci --ignore-scripts=false', files)).toEqual(['npm:only-allow (exec)', 'npm:expresss']);
    // Packages named on the line are checked either way.
    expect(cmd('npm i --ignore-scripts expresss', files)).toEqual(['npm:expresss']);
  });
});

describe('workspace filters are not packages', () => {
  it.each([
    ['bun install --filter @opencode/stats-server --frozen-lockfile --ignore-scripts', []],
    ['bun install -F ./packages/web', []],
    ['pnpm install --filter @scope/app', []],
    ['bun add --filter @scope/app expresss', ['npm:expresss']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('uvx and uv tool take name@version', () => {
  it.each([
    ['uvx ruff@0.15.0 check src tests', ['pypi:ruff ==0.15.0 (exec)']],
    ['uvx ruff@latest check', ['pypi:ruff (exec)']],
    ['uvx --from pip-audit@2.10.0 pip-audit', ['pypi:pip-audit ==2.10.0 (exec)']],
    ['uv tool install ruff@0.6.0', ['pypi:ruff ==0.6.0 (exec)']],
    ['uvx reqeusts@1.0', ['pypi:reqeusts ==1.0 (exec)']],
    // A direct reference is still a URL.
    ['uvx --from "ruff @ https://example.com/ruff.whl" ruff', ['?pypi']],
    ['uvx --from git+https://github.com/x/y ruff', ['?pypi']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('--find-links to a local folder', () => {
  it.each([
    ['pip install ruff --no-index --find-links dist/ --force-reinstall', ['pypi:ruff']],
    ['uv pip install pydantic-core --no-index --no-deps --find-links dist --force-reinstall', ['pypi:pydantic-core']],
    ['pip install -f ./wheels pkg-a', ['pypi:pkg-a']],
    ['pip install -f ./$dir pkg-a', ['pypi:pkg-a']],
    // A URL, a host and a variable are still sources pinright cannot vouch for.
    ['pip install -f https://example.com/wheels/ pkg-a', ['?pypi', 'pypi:pkg-a']],
    ['pip install -f localhost:8080/simple pkg-a', ['?pypi', 'pypi:pkg-a']],
    ['pip install -f $LINKS pkg-a', ['?pypi', 'pypi:pkg-a']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));

  it('in a requirements file too', () => {
    expect(cmd('pip install -r r.txt', { '/p/r.txt': '--find-links ./vendor\nreqeusts\n' })).toEqual(['pypi:reqeusts']);
    expect(cmd('pip install -r r.txt', { '/p/r.txt': '--find-links https://example.com/w\nreqeusts\n' })).toEqual(['?pypi', 'pypi:reqeusts']);
    expect(write('/p/requirements.txt', '-f ./vendor\nflask==3.0.0\n', 'flask==3.0.0\n')).toEqual([]);
    // The unchanged pin comes along as context for the compatibility check.
    expect(write('/p/requirements.txt', '-f https://example.com/w\nflask==3.0.0\n', 'flask==3.0.0\n')).toEqual(['?pypi', 'pypi:flask ==3.0.0']);
  });
});

describe('registry credentials are not registry switches', () => {
  it('npm config set and .npmrc auth lines pass', () => {
    expect(cmd('npm config set //registry.npmjs.org/:_authToken ${NPM_TOKEN}')).toEqual([]);
    expect(cmd('npm config set //npm.pkg.github.com/:_authToken=$GH_TOKEN')).toEqual([]);
    expect(cmd('echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc')).toEqual([]);
    expect(write('/p/.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nalways-auth=true\n', '')).toEqual([]);
  });
  it('the lines that do switch the registry still ask', () => {
    expect(cmd('npm config set registry http://localhost:4873/')).toEqual(['?npm']);
    expect(write('/p/.npmrc', '@acme:registry=https://npm.acme.example/\n//npm.acme.example/:_authToken=x\n', '')).toEqual(['?npm']);
  });
});

describe('a freeze or export of what is installed', () => {
  it.each([
    ['pip freeze > requirements.txt', []],
    ['python -m pip freeze > requirements_nocomfyui.txt', []],
    ['uv pip freeze > requirements/dev.txt', []],
    ['pip list --format=freeze > requirements.txt', []],
    ['poetry export -f requirements.txt > requirements.txt', []],
    ['uv export --no-hashes > requirements.txt', []],
    // Another program's output into a requirements file still cannot be read.
    ['grep -v torch requirements.txt > requirements-cpu.txt', ['?pypi']],
    ['curl -fsSL https://example.com/reqs.txt > requirements.txt', ['?pypi']],
    // And a freeze into a manifest that is not a requirements file is still a write pinright cannot read.
    ['pip freeze > package.json', ['?npm']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('uv pip sync and pip-sync install what the file lists', () => {
  const files = { '/p/requirements.txt': 'reqeusts==1.0\n', '/p/dev.txt': 'expresss-py\n' };
  it.each([
    ['uv pip sync requirements.txt', ['pypi:reqeusts ==1.0']],
    ['uv pip sync requirements.txt dev.txt', ['pypi:reqeusts ==1.0', 'pypi:expresss-py']],
    ['pip-sync', ['pypi:reqeusts ==1.0']],
    ['pip-sync dev.txt', ['pypi:expresss-py']],
  ])('%s', (c, want) => expect(cmd(c, files)).toEqual(want));
});

describe('recursive make', () => {
  // A chain of sub-makes like nodejs/node's coverage targets, deeper than the nesting limit.
  const chain = Array.from({ length: 12 }, (_, k) => `t${k}:\n\t$(MAKE) t${k + 1}\n`).join('') + 't12:\n\tpip install reqeusts\n';
  it('a long chain of $(MAKE) targets is read to the end', () => {
    expect(cmd('make t0', { '/p/Makefile': chain })).toEqual(['pypi:reqeusts']);
    expect(cmd('make t0', { '/p/Makefile': chain.replace('pip install reqeusts', 'go test ./...') })).toEqual([]);
  });
  it('a Makefile that calls itself in a loop ends', () => {
    expect(cmd('make a', { '/p/Makefile': 'a:\n\t$(MAKE) b\nb:\n\t$(MAKE) a\n\tnpm i expresss\n' })).toEqual(['npm:expresss']);
  });
});

describe('Go module versions', () => {
  it('a pinned Go version is looked up with its "v", as deps.dev lists it', async () => {
    const { assessPackage } = await import('../src/advisories/resolve.js');
    fixtures.clear();
    const v = { versionKey: { system: 'GO', name: 'github.com/x/tool', version: 'v1.2.0' }, publishedAt: '2025-01-01T00:00:00Z', isDefault: true };
    fixtures.set('/packages/github.com%2Fx%2Ftool/versions/v1.2.0', { ...v, licenses: ['MIT'], advisoryKeys: [] });
    fixtures.set('/packages/github.com%2Fx%2Ftool', { packageKey: { system: 'GO', name: 'github.com/x/tool' }, versions: [v] });
    fixtures.set('/v1/query', { vulns: [] });
    fixtures.set('/v1/querybatch', { results: [] });
    for (const pin of ['v1.2.0', '1.2.0']) {
      const r = await assessPackage('go', 'github.com/x/tool', pin);
      expect(r.requested?.verdict, pin).toBe('ok');
    }
    // A version that really is missing still reads as never published.
    expect((await assessPackage('go', 'github.com/x/tool', 'v9.9.9')).requested?.verdict).toBe('unknown-package');
  });
});

describe('go install of a command inside a module', () => {
  it('checks the module that holds the package, not a module named after the package path', async () => {
    const { goModule } = await import('../src/hook/policy.js');
    fixtures.clear();
    const v = { versionKey: { system: 'GO', name: 'golang.org/x/vuln', version: 'v1.1.0' }, isDefault: true };
    fixtures.set('/packages/golang.org%2Fx%2Fvuln', { packageKey: { system: 'GO', name: 'golang.org/x/vuln' }, versions: [v] });
    expect(await goModule('golang.org/x/vuln/cmd/govulncheck')).toBe('golang.org/x/vuln');
    expect(await goModule('golang.org/x/vuln')).toBe('golang.org/x/vuln');
    // Nothing known on the way up: the path stays as written, and the check reports it as unknown.
    expect(await goModule('github.com/evil/tool/cmd/tool')).toBe('github.com/evil/tool/cmd/tool');
  });
});

describe('pip --group (pip 25.1+) takes a group name', () => {
  it.each([
    ['pip install --group tests --editable .[all]', []],
    ['pip install --group dev reqeusts', ['pypi:reqeusts']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('a version the shell computes is unknown, not "never published"', () => {
  it.each([
    ['cargo install cargo-zigbuild --locked --version "$CARGO_ZIGBUILD_VERSION"', ['?cargo']],
    ['cargo install cargo-zigbuild --locked --version 0.19.8', ['cargo:cargo-zigbuild 0.19.8 (exec)']],
    ['echo "yt-dlp-ejs==$(cat EJS_VERSION)" > requirements-ejs.txt', ['?pypi']],
    ['echo "yt-dlp-ejs==0.8.0" > requirements-ejs.txt', ['pypi:yt-dlp-ejs ==0.8.0']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('a requirement with "--hash sha256:..." (space, not "=")', () => {
  it('reads the version without the hash', () => {
    expect(write('/p/.ejs-requirements.txt', 'yt-dlp-ejs==0.8.0 --hash sha256:79300e5fca7f\n')).toEqual(['pypi:yt-dlp-ejs ==0.8.0']);
    expect(write('/p/requirements.txt', 'yt-dlp-ejs==0.8.0 --hash=sha256:79300e5fca7f\n')).toEqual(['pypi:yt-dlp-ejs ==0.8.0']);
  });
});

describe('go install at a commit or a branch', () => {
  it.each([
    ['go install github.com/blampe/goat/cmd/goat@177de93b192b8ffae608e5d9ec421cc99bf68402', ['?go']],
    ['go install github.com/x/y@main', ['?go']],
    ['go install github.com/x/y@v1.2.3', ['go:github.com/x/y 1.2.3 (exec)']],
    ['go install github.com/x/y@latest', ['go:github.com/x/y (exec)']],
    ['go get github.com/x/y@v0.0.0-20240101000000-abcdef123456', ['go:github.com/x/y 0.0.0-20240101000000-abcdef123456']],
  ])('%s', (c, want) => expect(cmd(c)).toEqual(want));
});

describe('make expansion keeps the reading budget (R4)', () => {
  it('a recipe padded past the command budget is still cut, not passed', () => {
    const padded = `pad:\n${'\ttrue\n'.repeat(2100)}\tnpm i expresss\n`;
    expect(cmd('make pad', { '/p/Makefile': padded })).toContain('?npm');
  });
  it('sub-makes padded past the budget are cut too', () => {
    const chain = Array.from({ length: 30 }, (_, k) => `t${k}:\n${'\ttrue\n'.repeat(100)}\t$(MAKE) t${k + 1}\n`).join('') + 't30:\n\tnpm i expresss\n';
    expect(cmd('make t0', { '/p/Makefile': chain })).toContain('?npm');
  });
});
