/* eslint-disable @typescript-eslint/no-explicit-any -- tool inputs come from transcripts */
/**
 * Replays every query-docs call the safectx arm made in a run against the
 * current code (src/, in-process MCP server), and counts which of the task's
 * new-API markers the answers contain, before (as recorded) and now. Measures
 * a docs fix without re-running the agents, on exactly the questions they asked.
 *
 *   SAFECTX_CONTEXT7=off GITHUB_TOKEN=... npx tsx bench/docs/replay.ts <stamp> [--arm safectx] [--only t1,t2]
 */
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { buildMcpServer } from '../../src/mcp.js';
import { MARKERS } from './retrieval.js';
import type { DocsRunScore } from './score.js';

const args = process.argv.slice(2);
const stamp = args[0];
if (!stamp) throw new Error('usage: replay.ts <stamp> [--arm safectx] [--only t1,t2]');
const arm = args.includes('--arm') ? args[args.indexOf('--arm') + 1] : 'safectx';
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',') : [];
const runDir = join(resolve(import.meta.dirname, '..', '..'), 'bench', 'docs', 'runs', stamp);
const scores: DocsRunScore[] = JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'));

const server = buildMcpServer();
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'replay', version: '0' });
await client.connect(b);

const hits = (texts: string[], markers: RegExp[]) => markers.filter((m) => texts.some((t) => m.test(t))).length;
console.log('| Task | Run | query-docs calls | Markers before | Markers now | Chars before | Chars now |');
console.log('|---|---|---|---|---|---|---|');
for (const r of scores.filter((s) => s.arm === arm && (!only.length || only.includes(s.task))).sort((x, y) => x.task.localeCompare(y.task) || x.rep - y.rep)) {
  const markers = MARKERS[r.task] ?? [];
  const calls = r.calls.filter((c) => c.tool.endsWith('query-docs'));
  const before = calls.map((c) => c.result ?? '');
  const now: string[] = [];
  for (const c of calls) {
    const res: any = await client.callTool({ name: 'query-docs', arguments: c.input });
    now.push((res.content ?? []).map((x: any) => x.text ?? '').join('\n'));
  }
  const chars = (xs: string[]) => xs.reduce((n, x) => n + x.length, 0);
  console.log(`| ${r.task} | r${r.rep} | ${calls.length} | ${hits(before, markers)} / ${markers.length} | ${hits(now, markers)} / ${markers.length} | ${chars(before)} | ${chars(now)} |`);
}
await client.close();
