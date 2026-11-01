/**
 * Where a package is declared, per dependency file, for SARIF regions.
 */
import { describe, expect, it } from 'vitest';
import { locatePackage, locateUses } from '../src/sarif/locate.js';

const line = (file: string, content: string, eco: Parameters<typeof locatePackage>[2], name: string, version?: string) =>
  locatePackage(file, content, eco, name, version)?.startLine;

describe('locatePackage', () => {
  it('package.json: the dependency sections, not other keys', () => {
    const pj = [
      '{', //                                   1
      '  "name": "app",', //                    2
      '  "scripts": { "lodash": "echo" },', //   3
      '  "dependencies": {', //                 4
      '    "react": "^19.0.0",', //             5
      '    "lodash": "4.17.20"', //             6
      '  },', //                                7
      '  "devDependencies": {', //              8
      '    "@types/node": "^22"', //            9
      '  }', //                                 10
      '}',
    ].join('\n');
    expect(line('package.json', pj, 'npm', 'lodash')).toBe(6);
    expect(line('package.json', pj, 'npm', '@types/node')).toBe(9);
    expect(locatePackage('package.json', pj, 'npm', 'lodash')).toEqual({ startLine: 6, startColumn: 6, endColumn: 12 });
    expect(line('package.json', pj, 'npm', 'left-pad')).toBeUndefined();
  });

  it('package-lock.json v3: the entry with the locked version, shallowest first', () => {
    const lock = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '1.0.0', ms: '2.1.3' } },
          'node_modules/a': { version: '1.0.0', dependencies: { ms: '2.0.0' } },
          'node_modules/a/node_modules/ms': { version: '2.0.0' },
          'node_modules/ms': { version: '2.1.3' },
        },
      },
      null,
      2,
    );
    const lines = lock.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(s)) + 1;
    expect(line('package-lock.json', lock, 'npm', 'ms', '2.0.0')).toBe(at('"node_modules/a/node_modules/ms"'));
    expect(line('package-lock.json', lock, 'npm', 'ms', '2.1.3')).toBe(at('"node_modules/ms"'));
    expect(line('package-lock.json', lock, 'npm', 'a', '1.0.0')).toBe(at('"node_modules/a"'));
  });

  it('package-lock.json v1: nested "dependencies" objects', () => {
    const lock = ['{', '  "lockfileVersion": 1,', '  "dependencies": {', '    "minimist": {', '      "version": "0.0.8"', '    }', '  }', '}'].join('\n');
    expect(line('package-lock.json', lock, 'npm', 'minimist', '0.0.8')).toBe(4);
  });

  it('yarn.lock and pnpm-lock.yaml', () => {
    const yarn = ['# yarn lockfile v1', '', '"@babel/core@^7.0.0", "@babel/core@^7.1.0":', '  version "7.2.0"', '', 'lodash@^4.17.0:', '  version "4.17.20"'].join('\n');
    expect(line('yarn.lock', yarn, 'npm', 'lodash', '4.17.20')).toBe(6);
    expect(line('yarn.lock', yarn, 'npm', '@babel/core', '7.2.0')).toBe(3);
    const pnpm = ['lockfileVersion: 9.0', 'importers:', '  .:', '    dependencies:', '      lodash:', '        specifier: ^4', '        version: 4.17.20', 'packages:', '  lodash@4.17.20:', '    resolution: {integrity: x}', "  '@scope/pkg@1.0.0':", '    resolution: {integrity: y}'].join('\n');
    expect(line('pnpm-lock.yaml', pnpm, 'npm', 'lodash', '4.17.20')).toBe(9);
    expect(line('pnpm-lock.yaml', pnpm, 'npm', '@scope/pkg', '1.0.0')).toBe(11);
  });

  it('requirements.txt: PyPI names normalize, comments and options are skipped', () => {
    const req = ['# pinned', '--index-url https://pypi.org/simple', 'Django==4.2.0', 'typing_extensions>=4', 'requests[socks] ; python_version > "3.8"', 'flask'].join('\n');
    expect(line('requirements.txt', req, 'pypi', 'django')).toBe(3);
    expect(line('requirements-dev.txt', req, 'pypi', 'typing-extensions')).toBe(4);
    expect(line('requirements.txt', req, 'pypi', 'requests')).toBe(5);
    expect(line('requirements.txt', req, 'pypi', 'flask')).toBe(6);
    expect(line('requirements.txt', req, 'pypi', 'fla')).toBeUndefined();
  });

  it('pyproject.toml: PEP 621 arrays and Poetry tables', () => {
    const pep = ['[project]', 'name = "app"', 'dependencies = [', '  "httpx>=0.27",', '  "Pydantic[email]==2.7.0",', ']'].join('\n');
    expect(line('pyproject.toml', pep, 'pypi', 'httpx')).toBe(4);
    expect(line('pyproject.toml', pep, 'pypi', 'pydantic')).toBe(5);
    const poetry = ['[tool.poetry]', 'name = "app"', '', '[tool.poetry.dependencies]', 'python = "^3.11"', 'requests = "^2.31"', '', '[tool.poetry.group.dev.dependencies]', 'pytest = "^8"'].join('\n');
    expect(line('pyproject.toml', poetry, 'pypi', 'requests')).toBe(6);
    expect(line('pyproject.toml', poetry, 'pypi', 'pytest')).toBe(9);
  });

  it('TOML lockfiles: the [[package]] with the version', () => {
    const lock = ['[[package]]', 'name = "idna"', 'version = "2.10"', '', '[[package]]', 'name = "idna"', 'version = "3.7"'].join('\n');
    expect(line('poetry.lock', lock, 'pypi', 'idna', '3.7')).toBe(6);
    expect(line('uv.lock', lock, 'pypi', 'IDNA', '2.10')).toBe(2);
    const cargo = ['[[package]]', 'name = "serde"', 'version = "1.0.200"'].join('\n');
    expect(line('Cargo.lock', cargo, 'cargo', 'serde', '1.0.200')).toBe(2);
  });

  it('Cargo.toml and go.mod', () => {
    const toml = ['[package]', 'name = "tokio"', '', '[dependencies]', 'tokio = { version = "1" }', '', '[dependencies.serde]', 'version = "1"'].join('\n');
    expect(line('Cargo.toml', toml, 'cargo', 'tokio')).toBe(5);
    expect(line('Cargo.toml', toml, 'cargo', 'serde')).toBe(7);
    const gomod = ['module example.com/app', '', 'go 1.22', '', 'require (', '\tgithub.com/gin-gonic/gin v1.9.0', '\tgolang.org/x/net v0.20.0 // indirect', ')', 'require github.com/pkg/errors v0.9.1'].join('\n');
    expect(line('go.mod', gomod, 'go', 'golang.org/x/net')).toBe(7);
    expect(line('go.mod', gomod, 'go', 'github.com/pkg/errors')).toBe(9);
  });

  it('pom.xml: the artifactId next to its groupId', () => {
    const pom = [
      '<project>',
      '  <artifactId>app</artifactId>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>org.other</groupId>',
      '      <artifactId>jackson-databind</artifactId>',
      '    </dependency>',
      '    <dependency>',
      '      <groupId>com.fasterxml.jackson.core</groupId>',
      '      <artifactId>jackson-databind</artifactId>',
      '      <version>2.9.0</version>',
      '    </dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n');
    expect(line('pom.xml', pom, 'maven', 'com.fasterxml.jackson.core:jackson-databind')).toBe(10);
  });

  it('Gradle scripts, version catalogs and lockfiles', () => {
    const gradle = ['dependencies {', '    implementation("org.slf4j:slf4j-api:2.0.9")', "    implementation group: 'com.google.guava', name: 'guava', version: '33.0.0-jre'", '}'].join('\n');
    expect(line('build.gradle.kts', gradle, 'maven', 'org.slf4j:slf4j-api')).toBe(2);
    expect(line('build.gradle', gradle, 'maven', 'com.google.guava:guava')).toBe(3);
    const catalog = ['[libraries]', 'okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }'].join('\n');
    expect(line('libs.versions.toml', catalog, 'maven', 'com.squareup.okhttp3:okhttp')).toBe(2);
    const lock = ['# This is a Gradle generated file', 'org.slf4j:slf4j-api:2.0.9=compileClasspath'].join('\n');
    expect(line('gradle.lockfile', lock, 'maven', 'org.slf4j:slf4j-api', '2.0.9')).toBe(2);
  });

  it('composer.json and composer.lock', () => {
    const json = ['{', '  "name": "acme/app",', '  "require": {', '    "php": "^8.2",', '    "guzzlehttp/guzzle": "^7.0"', '  },', '  "require-dev": {', '    "phpunit/phpunit": "^10"', '  }', '}'].join('\n');
    expect(line('composer.json', json, 'composer', 'guzzlehttp/guzzle')).toBe(5);
    expect(line('composer.json', json, 'composer', 'phpunit/phpunit')).toBe(8);
    const lock = ['{', '  "packages": [', '    {', '      "name": "guzzlehttp/guzzle",', '      "version": "7.8.1"', '    }', '  ]', '}'].join('\n');
    expect(line('composer.lock', lock, 'composer', 'guzzlehttp/guzzle', '7.8.1')).toBe(4);
  });

  it('Gemfile.lock and NuGet packages.lock.json', () => {
    const gem = ['GEM', '  specs:', '    rack (2.2.8)', '    rails (7.1.0)', '      rack (>= 2.2.4)'].join('\n');
    expect(line('Gemfile.lock', gem, 'rubygems', 'rack', '2.2.8')).toBe(3);
    const nuget = ['{', '  "dependencies": {', '    "net8.0": {', '      "Newtonsoft.Json": {', '        "resolved": "13.0.1"'].join('\n');
    expect(line('packages.lock.json', nuget, 'nuget', 'newtonsoft.json')).toBe(4);
  });

  it('workflow files: the action reference on its uses: line', () => {
    const wf = ['jobs:', '  b:', '    steps:', '      - uses: actions/checkout@v4', '      - name: x', "        uses: 'tj-actions/changed-files@v35' # pinned?"].join('\n');
    expect(locateUses(wf, 4)).toEqual({ startLine: 4, startColumn: 15, endColumn: 34 });
    expect(locateUses(wf, 6)).toEqual({ startLine: 6, startColumn: 16, endColumn: 44 });
  });
});
