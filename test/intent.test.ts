import { describe, expect, it } from 'vitest';
import { fromCommand, fromFileWrite, splitCommands } from '../src/hook/intent.js';
import { intentsFromToolInput } from '../src/hook/run.js';

const none = () => undefined;
const pick = (cmd: string, files: Record<string, string> = {}) =>
  fromCommand(cmd, '/p', (p) => files[p.replace(/\\/g, '/').replace(/^[A-Z]:/, '')]).map((i) => i.unverifiable ? `?${i.ecosystem}` : `${i.ecosystem}:${i.name}${i.spec ? ` ${i.spec}` : ''}${i.executes ? ' (exec)' : ''}`);

describe('splitCommands', () => {
  it('splits on separators and honors quotes', () => {
    expect(splitCommands('cd a && npm i "x y" ; echo 1 | cat')).toEqual([['cd', 'a'], ['npm', 'i', 'x y'], ['echo', '1'], ['cat']]);
  });
});

describe('fromCommand', () => {
  it('npm, pnpm, yarn, bun installs with versions, scopes and flags', () => {
    expect(pick('npm install --save-dev axios@1.7.9 @types/node lodash@^4')).toEqual(['npm:axios 1.7.9', 'npm:@types/node', 'npm:lodash ^4']);
    expect(pick('pnpm add -D zod && yarn add react@19 && bun add hono')).toEqual(['npm:zod', 'npm:react 19', 'npm:hono']);
    expect(pick('npm install')).toEqual([]);
    expect(pick('npm i ./local ../x file:../y git+https://g/x.git user/repo pkg.tgz')).toEqual(['?npm', '?npm']);
  });

  it('executed packages: npx, pnpm dlx, uvx, pipx run', () => {
    expect(pick('npx -y create-next-app@latest app')).toEqual(['npm:create-next-app latest (exec)']);
    expect(pick('pnpm dlx shadcn@2 init')).toEqual(['npm:shadcn 2 (exec)']);
    expect(pick('uvx ruff check .')).toEqual(['pypi:ruff (exec)']);
    expect(pick('pipx run black')).toEqual(['pypi:black (exec)']);
  });

  it('pip, python -m pip, uv, poetry, requirements files', () => {
    // Unquoted, flask>=3 is a redirection in every shell; the custom index is something safectx cannot vouch for.
    expect(pick('pip install "requests[socks]==2.31.0" "flask>=3" -i https://x/simple')).toEqual(['?pypi', 'pypi:requests ==2.31.0', 'pypi:flask >=3']);
    expect(pick('python -m pip install -U PyYAML')).toEqual(['pypi:pyyaml']);
    expect(pick('uv pip install httpx && uv add fastapi==0.110.0 && poetry add pydantic')).toEqual(['pypi:httpx', 'pypi:fastapi ==0.110.0', 'pypi:pydantic']);
    expect(pick('pip install -r reqs.txt', { '/p/reqs.txt': 'django==4.2.0\n# c\n-e .\nrequests\n' })).toEqual(['pypi:django ==4.2.0', 'pypi:requests']);
    expect(pick('pip install -e .')).toEqual([]);
  });

  it('cargo, go, gem, bundle, dotnet', () => {
    expect(pick('cargo add serde@1.0.200 tokio')).toEqual(['cargo:serde 1.0.200', 'cargo:tokio']);
    expect(pick('go get github.com/gin-gonic/gin@v1.9.0 ./...')).toEqual(['go:github.com/gin-gonic/gin 1.9.0']);
    expect(pick('gem install rails -v 7.1.0 && bundle add rack --version 2.2.8')).toEqual(['rubygems:rails 7.1.0', 'rubygems:rack 2.2.8']);
    expect(pick('dotnet add package Newtonsoft.Json --version 12.0.1')).toEqual(['nuget:Newtonsoft.Json 12.0.1']);
  });

  it('ignores env prefixes and unrelated commands', () => {
    expect(pick('NODE_ENV=dev sudo npm i express')).toEqual(['npm:express']);
    expect(pick('git commit -m "npm install axios"')).toEqual([]);
    expect(fromCommand('ls -la', '/p', none)).toEqual([]);
  });
});

describe('fromFileWrite', () => {
  it('reports only added or re-versioned dependencies', () => {
    const before = '{"dependencies":{"express":"4.21.2","zod":"3.23.0"}}';
    const after = '{"dependencies":{"express":"4.21.2","zod":"3.25.0","axios":"1.7.9"},"devDependencies":{"tsx":"^4"}}';
    const intents = fromFileWrite('/p/package.json', after, before);
    expect(intents.filter((i) => !i.contextOnly).map((i) => `${i.name} ${i.spec}`)).toEqual(['zod 3.25.0', 'axios 1.7.9', 'tsx ^4']);
    // Unchanged lines ride along for the compatibility check only.
    expect(intents.filter((i) => i.contextOnly).map((i) => i.name)).toEqual(['express']);
    expect(fromFileWrite('/p/package.json', before, before)).toEqual([]);
  });

  it('new requirements file: every line counts; other files are ignored', () => {
    expect(fromFileWrite('/p/requirements.txt', 'flask==3.0.0\n', undefined).map((i) => i.name)).toEqual(['flask']);
    expect(fromFileWrite('/p/src/app.py', 'import x', undefined)).toEqual([]);
    expect(fromFileWrite('/p/node_modules/x/package.json', '{"dependencies":{"a":"1"}}', undefined)).toEqual([]);
  });
});

describe('intentsFromToolInput', () => {
  it('Bash commands and Write of a manifest', () => {
    expect(intentsFromToolInput('Bash', { command: 'npm i left-pad' }, '/p').map((i) => i.name)).toEqual(['left-pad']);
    expect(intentsFromToolInput('Write', { file_path: '/nowhere/requirements.txt', content: 'django==4.2.0' }, '/p').map((i) => i.name)).toEqual(['django']);
    expect(intentsFromToolInput('Write', { file_path: '/nowhere/README.md', content: 'npm i x' }, '/p')).toEqual([]);
  });
});
