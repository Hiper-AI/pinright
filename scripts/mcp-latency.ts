/**
 * MCP tool latency against the real upstreams, through the stdio server the way
 * an agent calls it. Run after `npm run build`:
 *   npx tsx scripts/mcp-latency.ts [--cli=<other dist/cli.js>]
 * Each tool runs twice: with an empty cache (cold) and right after (warm).
 * GITHUB_TOKEN is dropped unless --token. Not part of `npm test`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cli = args.find((a) => a.startsWith('--cli='))?.slice(6) ?? path.join(root, 'dist', 'cli.js');

const NPM = [
  'express', 'react', 'lodash', 'axios', 'zod', 'next', 'typescript', 'vite', 'dayjs', 'uuid',
  'dotenv', 'cors', 'jsonwebtoken', 'bcrypt', 'mongoose', 'pg', 'redis', 'winston', 'commander', 'chalk',
  'semver', 'yaml', 'ws', 'rxjs', 'prettier', 'eslint', 'vitest', 'jest', 'webpack', 'esbuild',
  'fastify', 'koa', 'hono', 'prisma', 'drizzle-orm', 'sequelize', 'knex', 'socket.io', 'helmet', 'morgan',
];
const batch = (n: number) => NPM.slice(0, n).map((name) => ({ name }));

const CALLS: { label: string; tool: string; args: Record<string, unknown> }[] = [
  { label: 'check-packages, 10', tool: 'check-packages', args: { packages: batch(10), ecosystem: 'npm' } },
  { label: 'check-packages, 40', tool: 'check-packages', args: { packages: batch(40), ecosystem: 'npm' } },
  { label: 'get-docs express routing', tool: 'get-docs', args: { libraryId: 'npm:express', query: 'routing and error handling middleware' } },
  { label: `check-manifest, package-lock.json`, tool: 'check-manifest', args: { path: path.join(root, 'package-lock.json') } },
];

const env = { ...process.env, SAFECTX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'safectx-mcp-cache-')) } as Record<string, string>;
if (!args.includes('--token')) {
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.SAFECTX_GH_CLI;
}
const client = new Client({ name: 'latency', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: 'ignore' }));

console.log('| tool | cold ms | warm ms | answer |\n|---|---|---|---|');
for (const c of CALLS) {
  const times: number[] = [];
  let note = '';
  for (let k = 0; k < 2; k++) {
    const t0 = performance.now();
    const res = await client.callTool({ name: c.tool, arguments: c.args }, undefined, { timeout: 600_000 });
    times.push(Math.round(performance.now() - t0));
    const body = (res.content as { text?: string }[]).map((x) => x.text ?? '').join('\n');
    const failed = body.match(/NOTE: some sources did not answer: (.*?)\. Whatever/)?.[1];
    note = `${res.isError ? 'ERROR ' : ''}${body.length} chars${failed ? `; did not answer: ${failed}` : ''}${/not checked/.test(body) ? ', some not checked' : ''}`;
  }
  console.log(`| ${c.label} | ${times[0]} | ${times[1]} | ${note} |`);
}
await client.close();
