/**
 * What each MCP tool call costs the agent in context: characters and approximate
 * tokens (chars / 4) of the answer, on a fixed list of calls. Drives one or two
 * builds over stdio with a real MCP client, so two builds can be compared side by side.
 *
 *   npm run build && npx tsx scripts/cost.ts [cliA] [cliB]
 *
 * Defaults to dist/cli.js. A build without check-packages gets the batch emulated
 * with one check-package call per package, which is what agents did before it existed.
 * COST_DUMP=<dir> also writes each answer to a file there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface Call { label: string; tool: string; args: Record<string, unknown> }

const BATCH = [
  { name: 'express', ecosystem: 'npm', version: '4.21.2' },
  { name: 'jsonwebtoken', ecosystem: 'npm', version: '8.5.1' },
  { name: 'bcryptjs', ecosystem: 'npm' },
  { name: 'dotenv', ecosystem: 'npm' },
  { name: 'zod', ecosystem: 'npm', version: '3.25.76' },
  { name: 'cors', ecosystem: 'npm' },
  { name: 'helmet', ecosystem: 'npm' },
  { name: 'fastapi', ecosystem: 'pypi', version: '0.115.0' },
  { name: 'pyjwt', ecosystem: 'pypi', version: '2.10.1' },
  { name: 'uvicorn', ecosystem: 'pypi' },
];

const CALLS: Call[] = [
  { label: 'resolve next.js', tool: 'resolve-library-id', args: { libraryName: 'next.js', query: 'middleware auth' } },
  { label: 'resolve fastapi', tool: 'resolve-library-id', args: { libraryName: 'fastapi', query: 'python jwt auth' } },
  { label: 'resolve typo reqeusts', tool: 'resolve-library-id', args: { libraryName: 'reqeusts', query: 'python http' } },
  { label: 'check express (ok)', tool: 'check-package', args: { name: 'express', ecosystem: 'npm' } },
  { label: 'check jsonwebtoken@8.5.1', tool: 'check-package', args: { name: 'jsonwebtoken', ecosystem: 'npm', version: '8.5.1' } },
  { label: 'check next@15.1.0', tool: 'check-package', args: { name: 'next', ecosystem: 'npm', version: '15.1.0' } },
  { label: 'docs next@15.1.0 middleware', tool: 'query-docs', args: { libraryId: 'npm:next@15.1.0', query: 'protect routes with middleware and redirect to login' } },
  { label: 'docs express error handling', tool: 'query-docs', args: { libraryId: 'npm:express', query: 'error handling middleware' } },
  { label: 'docs fastapi oauth2 jwt', tool: 'query-docs', args: { libraryId: 'pypi:fastapi', query: 'OAuth2 password bearer with JWT tokens' } },
  { label: `batch of ${BATCH.length} packages`, tool: 'check-packages', args: { packages: BATCH } },
];

interface Row { chars: number; calls: number; ms: number; error?: boolean }

async function measure(cli: string): Promise<Row[]> {
  const env = { ...process.env, SAFECTX_CONTEXT7: 'off' } as Record<string, string>;
  const client = new Client({ name: 'cost', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [cli], env }));
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  const one = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const body = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    if (process.env.COST_DUMP) {
      fs.mkdirSync(process.env.COST_DUMP, { recursive: true });
      const file = `${tool}-${JSON.stringify(args).replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.txt`;
      fs.writeFileSync(path.join(process.env.COST_DUMP, file), body);
    }
    return { chars: body.length, error: Boolean(res.isError) };
  };
  const rows: Row[] = [];
  for (const c of CALLS) {
    const t0 = Date.now();
    if (c.tool === 'check-packages' && !tools.has('check-packages')) {
      let chars = 0;
      for (const p of BATCH) chars += (await one('check-package', p)).chars;
      rows.push({ chars, calls: BATCH.length, ms: Date.now() - t0 });
    } else {
      const r = await one(c.tool, c.args);
      rows.push({ ...r, calls: 1, ms: Date.now() - t0 });
    }
  }
  await client.close();
  return rows;
}

const clis = process.argv.slice(2);
if (!clis.length) clis.push('dist/cli.js');
const results = [];
for (const cli of clis) results.push(await measure(cli));

const tok = (chars: number) => Math.round(chars / 4);
const head = ['call', ...clis.flatMap((_, i) => [`${'AB'[i]} chars`, `${'AB'[i]} ~tokens`, `${'AB'[i]} calls`])];
if (clis.length === 2) head.push('change');
console.log(clis.map((c, i) => `${'AB'[i]} = ${c}`).join('\n'));
console.log(`\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
const totals = clis.map(() => ({ chars: 0, calls: 0 }));
CALLS.forEach((c, i) => {
  const cells = [c.label];
  results.forEach((r, j) => {
    cells.push(String(r[i].chars) + (r[i].error ? ' (error)' : ''), String(tok(r[i].chars)), String(r[i].calls));
    totals[j].chars += r[i].chars;
    totals[j].calls += r[i].calls;
  });
  if (clis.length === 2) cells.push(`${Math.round((results[1][i].chars / Math.max(1, results[0][i].chars) - 1) * 100)}%`);
  console.log(`| ${cells.join(' | ')} |`);
});
const tot = ['**total**', ...totals.flatMap((t) => [String(t.chars), String(tok(t.chars)), String(t.calls)])];
if (clis.length === 2) tot.push(`${Math.round((totals[1].chars / Math.max(1, totals[0].chars) - 1) * 100)}%`);
console.log(`| ${tot.join(' | ')} |`);
