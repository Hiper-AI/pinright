/* eslint-disable @typescript-eslint/no-explicit-any -- transcripts are untyped JSON */
/**
 * Token counts of one benchmark run, read from its Claude Code transcript.
 *
 * The totals come from the `modelUsage` block of the final `result` line, the same block
 * Claude Code prices `total_cost_usd` from, summed over every model the session used (the
 * run's model plus a small helper call). `mcpResultChars` is the text the MCP tools
 * returned to the agent, the part of the context a docs or verdict server adds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunTokens {
  /** Input tokens sent without the prompt cache. */
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  /** input + cacheRead + cacheCreation + output. */
  total: number;
  /** Characters of every MCP tool result the agent read. */
  mcpResultChars: number;
  /** get-docs calls, and those that named no version (in `version` or as `name@version` in the id). */
  getDocs: number;
  getDocsNoVersion: number;
  /** Short name of the first tool the agent called (`check-packages`, `get-docs`, `Write`, ...). */
  firstTool?: string;
}

/** undefined when the transcript is missing or has no result line with usage. */
export function readTokens(dir: string): RunTokens | undefined {
  const p = join(dir, 'transcript.jsonl');
  if (!existsSync(p)) return undefined;
  const lines: any[] = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = lines.find((l) => l.type === 'result');
  const usage: any[] = Object.values(res?.modelUsage ?? {});
  if (!usage.length) return undefined;
  const add = (k: string) => usage.reduce((a, u) => a + (Number(u[k]) || 0), 0);
  const mcp = new Set<string>();
  let mcpResultChars = 0;
  let getDocs = 0;
  let getDocsNoVersion = 0;
  let firstTool: string | undefined;
  for (const l of lines) {
    for (const c of l.message?.content ?? []) {
      if (l.type === 'assistant' && c.type === 'tool_use') firstTool ??= String(c.name).split('__').pop();
      if (l.type === 'assistant' && c.type === 'tool_use' && String(c.name).startsWith('mcp__')) {
        mcp.add(c.id);
        if (/__(get|query)-docs$/.test(String(c.name))) {
          getDocs++;
          if (!c.input?.version && !/@\d/.test(String(c.input?.libraryId ?? ''))) getDocsNoVersion++;
        }
      }
      if (l.type === 'user' && c.type === 'tool_result' && mcp.has(c.tool_use_id)) {
        mcpResultChars += (Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : String(c.content ?? '')).length;
      }
    }
  }
  const t = { input: add('inputTokens'), cacheRead: add('cacheReadInputTokens'), cacheCreation: add('cacheCreationInputTokens'), output: add('outputTokens') };
  return { ...t, total: t.input + t.cacheRead + t.cacheCreation + t.output, mcpResultChars, getDocs, getDocsNoVersion, firstTool };
}
