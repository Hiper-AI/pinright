import fs from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { cursorLink, mcpbManifest, readmeWithBlocks, readPkg, serverJson, vscodeLink } from '../scripts/distribution.js';
import { MCP_NAME, PKG_NAME } from '../src/pkg.js';

const pkg = readPkg();
const schema = (file: string) => {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return ajv.compile(JSON.parse(fs.readFileSync(`test/fixtures/${file}`, 'utf8')));
};

describe('distribution artifacts', () => {
  it('the name lives in package.json: the code and the registry entry read it from there', () => {
    expect(PKG_NAME).toBe(pkg.name);
    expect(MCP_NAME).toBe(pkg.mcpName);
    // The MCP Registry compares the namespace with the GitHub login byte for byte.
    expect(pkg.mcpName).toBe(`io.github.Hiper-AI/${pkg.name}`);
  });

  it('server.json is current and matches the MCP Registry schema (2025-12-11)', () => {
    const json = serverJson(pkg);
    const validate = schema('mcp-server-2025-12-11.schema.json');
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    expect(fs.readFileSync('server.json', 'utf8')).toBe(`${JSON.stringify(json, null, 2)}\n`);
    expect(json).toMatchObject({ name: pkg.mcpName, version: pkg.version, packages: [{ registryType: 'npm', identifier: pkg.name, version: pkg.version }] });
  });

  it('the .mcpb manifest matches the MCPB 0.3 schema and never carries a token value', () => {
    const manifest = mcpbManifest(pkg, [{ name: 'get-docs', description: 'Docs.' }]);
    const validate = schema('mcpb-manifest-v0.3.schema.json');
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify((manifest.server as { mcp_config: unknown }).mcp_config)).toContain('${user_config.github_token}');
  });

  it('the README install blocks are generated from the client registry and are current', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readmeWithBlocks(readme, pkg)).toBe(readme);
  });

  it('install links carry the same entry init writes', () => {
    const cursor = new URL(cursorLink(pkg));
    expect(JSON.parse(Buffer.from(cursor.searchParams.get('config')!, 'base64').toString())).toEqual({ command: 'npx', args: ['-y', pkg.name] });
    const redirect = new URL(vscodeLink(pkg)).searchParams.get('url')!;
    expect(redirect.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(redirect.slice('vscode:mcp/install?'.length)))).toEqual({ name: pkg.name, type: 'stdio', command: 'npx', args: ['-y', pkg.name] });
  });
});
