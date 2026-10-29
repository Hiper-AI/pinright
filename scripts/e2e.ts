/**
 * Drives the built server over stdio with a real MCP client, like an agent would.
 * Run: npm run build && npx tsx scripts/e2e.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

async function call(name: string, args: Record<string, unknown>, maxChars = 1800) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const body = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  console.log(`\n### ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms, ${body.length} chars)${res.isError ? ' [isError]' : ''}\n${body.slice(0, maxChars)}${body.length > maxChars ? '\n...' : ''}`);
}

await call('resolve-library-id', { libraryName: 'next.js', query: 'middleware auth' });
await call('query-docs', { libraryId: '/vercel/next.js/v15.1.8', query: 'middleware redirect', language: 'typescript' }, 1400);
await call('query-docs', { libraryId: '/vercel/next.js', query: 'middleware redirect' }, 600);
await call('check-package', { name: 'jsonwebtoken', ecosystem: 'npm', version: '8.5.1' });
await call('check-package', { name: 'reqeusts', ecosystem: 'python' });

await client.close();
