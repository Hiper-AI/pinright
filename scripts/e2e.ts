/**
 * Drives the built CLI over stdio with a real MCP client, like an agent would.
 * Run: npm run build && npx tsx scripts/e2e.ts [lockfile-dir]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/cli.js'], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

async function call(name: string, args: Record<string, unknown>, maxChars = 1500) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const body = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  console.log(`\n### ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms, ${body.length} chars)${res.isError ? ' [isError]' : ''}\n${body.slice(0, maxChars)}${body.length > maxChars ? '\n...' : ''}`);
}

await call('resolve-library-id', { libraryName: 'next.js', query: 'middleware auth' }, 900);
await call('query-docs', { libraryId: 'npm:next@15.1.0', query: 'protect routes with middleware and redirect to login' }, 1600);
await call('query-docs', { libraryId: '/vercel/next.js', query: 'middleware redirect' }, 500);
await call('query-docs', { libraryId: 'pypi:requests', query: 'retry with backoff' }, 900);
await call('check-package', { name: 'jsonwebtoken', ecosystem: 'npm', version: '8.5.1' }, 700);
await call('check-packages', { ecosystem: 'npm', packages: [{ name: 'express' }, { name: 'jsonwebtoken', version: '8.5.1' }, { name: 'expresss' }] }, 1200);
await call('resolve-library-id', { libraryName: 'reqeusts', query: 'python http' });
if (process.argv[2]) await call('check-manifest', { path: process.argv[2] }, 2500);

await client.close();
