/**
 * Second task set for the agent benchmark: 12 requests taken from public GitHub issues,
 * not written by us. Selection rule, search snapshots and the per-result decisions are in
 * bench/RESULTS-real-issues.md; the raw search output is in bench/agents/real-issues/.
 *
 * The prompt is the issue body as posted, lightly trimmed (what was cut is recorded in
 * `trimmed`), inside a fixed frame that names the repository and the issue title, followed
 * by the same pinning rules as the v6 set. The body text lives in real-issues/<id>.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentTask, NPM_RULES, PY_RULES } from './tasks.js';

export interface IssueSource {
  url: string;
  repo: string;
  /** GitHub repository description on 2026-11-02 (empty when the repository has none). */
  repoDescription: string;
  number: number;
  title: string;
  createdAt: string;
  /** Issue state on 2026-11-02. */
  state: 'open' | 'closed';
  /** Position in the search snapshot the issue was taken from (1-based). */
  rank: number;
  trimmed: string;
}

export interface RealIssueTask extends AgentTask {
  source: IssueSource;
}

const SOURCES: (IssueSource & { id: string; ecosystem: 'npm' | 'pypi' })[] = [
  {
    id: 'mcp-hono', ecosystem: 'npm', rank: 6,
    url: 'https://github.com/modelcontextprotocol/typescript-sdk/issues/385', repo: 'modelcontextprotocol/typescript-sdk', number: 385,
    repoDescription: 'The official TypeScript SDK for Model Context Protocol servers and clients',
    title: 'Consider adding Hono examples', createdAt: '2025-04-22', state: 'closed',
    trimmed: 'The screenshot (an <img> tag) and the last paragraph (an offer to open a PR).',
  },
  {
    id: 'proton-drive-example', ecosystem: 'npm', rank: 22,
    url: 'https://github.com/ProtonDriveApps/sdk/issues/8', repo: 'ProtonDriveApps/sdk', number: 8,
    repoDescription: '',
    title: 'Example needed', createdAt: '2025-12-15', state: 'open',
    trimmed: 'The greeting ("Hello everyone,") and the sign-off.',
  },
  {
    id: 'mastra-deep-research', ecosystem: 'npm', rank: 29,
    url: 'https://github.com/mastra-ai/mastra/issues/2541', repo: 'mastra-ai/mastra', number: 2541,
    repoDescription: 'Mastra is the modern TypeScript framework for AI-powered applications and agents.',
    title: 'Examples: deep research', createdAt: '2025-02-25', state: 'closed',
    trimmed: 'Nothing.',
  },
  {
    id: 'assistant-ui-mcp-tools', ecosystem: 'npm', rank: 30,
    url: 'https://github.com/assistant-ui/assistant-ui/issues/1833', repo: 'assistant-ui/assistant-ui', number: 1833,
    repoDescription: 'Typescript/React Library for AI Chat',
    title: 'Example for custom backend tool call update', createdAt: '2025-04-14', state: 'closed',
    trimmed: 'Nothing (two emoji removed from the repository description).',
  },
  {
    id: 'next-gh-pages', ecosystem: 'npm', rank: 31,
    url: 'https://github.com/nextjs/deploy-github-pages/issues/2', repo: 'nextjs/deploy-github-pages', number: 2,
    repoDescription: 'Next.js template to deploy to GitHub Pages as a static site.',
    title: 'Example', createdAt: '2025-02-15', state: 'open',
    trimmed: 'Nothing.',
  },
  {
    id: 'openapi-fetch-next', ecosystem: 'npm', rank: 42,
    url: 'https://github.com/openapi-ts/openapi-typescript/issues/2242', repo: 'openapi-ts/openapi-typescript', number: 2242,
    repoDescription: 'Generate TypeScript types from OpenAPI 3 specs',
    title: 'Update docs and examples for Next.js', createdAt: '2025-04-03', state: 'open',
    trimmed: 'The "Extra" section (an unticked "willing to open a PR" checkbox).',
  },
  {
    id: 'mcp-remote-oauth', ecosystem: 'pypi', rank: 11,
    url: 'https://github.com/modelcontextprotocol/python-sdk/issues/618', repo: 'modelcontextprotocol/python-sdk', number: 618,
    repoDescription: 'The official Python SDK for Model Context Protocol servers and clients',
    title: 'Remote MCP Oauth Example', createdAt: '2025-05-02', state: 'closed',
    trimmed: 'Nothing.',
  },
  {
    id: 'kittentts-streaming', ecosystem: 'pypi', rank: 18,
    url: 'https://github.com/KittenML/KittenTTS/issues/54', repo: 'KittenML/KittenTTS', number: 54,
    repoDescription: 'Open-source State-of-the-art TTS model which runs on a CPU',
    title: 'Is there an example of streaming output?', createdAt: '2025-08-08', state: 'open',
    trimmed: 'Nothing (one emoji removed from the repository description).',
  },
  {
    id: 'openevolve-symreg', ecosystem: 'pypi', rank: 29,
    url: 'https://github.com/algorithmicsuperintelligence/openevolve/issues/15', repo: 'algorithmicsuperintelligence/openevolve', number: 15,
    repoDescription: 'Open-source implementation of AlphaEvolve',
    title: 'Feature Proposal: New Symbolic Regression Example for OpenEvolve', createdAt: '2025-05-21', state: 'closed',
    trimmed: 'The greeting, the last three paragraphs (an offer to refine the fork and open a PR, an offer of further examples, "Looking forward to your thoughts") and the sign-off.',
  },
  {
    id: 'pydantic-ai-deep-research', ecosystem: 'pypi', rank: 30,
    url: 'https://github.com/pydantic/pydantic-ai/issues/901', repo: 'pydantic/pydantic-ai', number: 901,
    repoDescription: 'How Python does AI. Agents, realtime voice, image generation, embeddings. Every model, every interface, typed end to end.',
    title: 'deep research example', createdAt: '2025-02-12', state: 'open',
    trimmed: 'Nothing.',
  },
  {
    id: 'stirrup-gdpval', ecosystem: 'pypi', rank: 32,
    url: 'https://github.com/ArtificialAnalysis/Stirrup/issues/8', repo: 'ArtificialAnalysis/Stirrup', number: 8,
    repoDescription: 'The lightweight framework for building agents',
    title: 'ENH: GDPval as an example', createdAt: '2025-12-19', state: 'open',
    trimmed: 'The issue template\'s "Initial Checks" checkbox and its empty "Alternatives Considered" section.',
  },
  {
    id: 'livekit-ultravox', ecosystem: 'pypi', rank: 38,
    url: 'https://github.com/livekit/agents/issues/1378', repo: 'livekit/agents', number: 1378,
    repoDescription: 'A framework for building realtime voice AI agents',
    title: 'Feature Request: Ultravox example', createdAt: '2025-01-15', state: 'closed',
    trimmed: 'The greeting ("Hi,"); two emoji removed from the repository description.',
  },
];

const dir = join(import.meta.dirname, 'real-issues');

/** The fixed frame around every issue body; only the repository, the title and the body change. */
export function issuePrompt(s: IssueSource, body: string, ecosystem: 'npm' | 'pypi'): string {
  const repo = s.repoDescription ? `${s.repo} (${s.repoDescription})` : s.repo;
  return [
    'Build a minimal, standalone project in the current directory that does what this GitHub issue asks for.',
    '',
    `Repository: ${repo}`,
    `Issue #${s.number}: ${s.title}`,
    '',
    body.trim(),
    '',
    ecosystem === 'npm' ? NPM_RULES : PY_RULES,
  ].join('\n');
}

export const REAL_ISSUE_TASKS: RealIssueTask[] = SOURCES.map(({ id, ecosystem, ...source }) => ({
  id,
  ecosystem,
  source,
  prompt: issuePrompt(source, readFileSync(join(dir, `${id}.md`), 'utf8').replace(/\r\n/g, '\n'), ecosystem),
}));
