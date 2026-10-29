# Prompt-injection detector: measured

Run on 2026-10-29 with `npx tsx bench/injection/run.ts` (live registries and GitHub, Context7 off).

## False positives on real documentation

32 packages (18 npm, 14 PyPI). Every chunk of every document query-docs gathered for them was scanned: **38381 chunks** (45.6 MB of text).

- High (the passage would be dropped): **4 chunks (0.01%)**
- Medium (kept, with a warning line): **26 chunks (0.07%)**
- In the actual query-docs answers for those 32 questions: 0 passages removed, 0 warnings.
- upgrade-guide on 6 real upgrades: 0 entries removed, 0 warnings.

Every flagged chunk is listed below for review. None of the packages is known to carry an injection, so each one is a false positive unless the excerpt says otherwise.

| package | files | chunks | high | medium | answer: removed/warned |
|---|---|---|---|---|---|
| npm:next@16.4.3 | 46 | 4618 | 1 | 3 | 0/0 |
| npm:react@19.3.1 | 28 | 687 | 0 | 0 | 0/0 |
| npm:express@5.3.0 | 5 | 837 | 0 | 0 | 0/0 |
| npm:zod@4.6.7 | 26 | 691 | 0 | 0 | 0/0 |
| npm:axios@1.20.0 | 34 | 446 | 0 | 0 | 0/0 |
| npm:lodash@4.18.1 | 1 | 3 | 0 | 0 | 0/0 |
| npm:vite@8.3.5 | 42 | 963 | 0 | 0 | 0/0 |
| npm:prisma@7.10.1 | 27 | 1889 | 0 | 2 | 0/0 |
| npm:@anthropic-ai/sdk@1.3.0 | 4 | 14 | 0 | 1 | 0/0 |
| npm:openai@7.45.0 | 28 | 265 | 0 | 1 | 0/0 |
| npm:ai@7.0.154 | 41 | 620 | 1 | 2 | 0/0 |
| npm:langchain@1.5.19 | 8 | 64 | 0 | 1 | 0/0 |
| npm:@modelcontextprotocol/sdk@1.32.2 | 8 | 2798 | 2 | 6 | 0/0 |
| npm:jsonwebtoken@9.0.3 | 1 | 21 | 0 | 0 | 0/0 |
| npm:dotenv@18.0.9 | 2 | 39 | 0 | 0 | 0/0 |
| npm:mongoose@9.11.4 | 47 | 503 | 0 | 0 | 0/0 |
| npm:fastify@5.12.7 | 44 | 18929 | 0 | 0 | 0/0 |
| npm:stripe@23.0.1 | 12 | 50 | 0 | 0 | 0/0 |
| pypi:requests@2.34.2 | 17 | 173 | 0 | 0 | 0/0 |
| pypi:fastapi@0.162.0 | 45 | 407 | 0 | 1 | 0/0 |
| pypi:pydantic@2.14.1 | 49 | 428 | 0 | 0 | 0/0 |
| pypi:django@6.1.2 | 5 | 20 | 0 | 0 | 0/0 |
| pypi:flask@3.1.3 | 45 | 353 | 0 | 0 | 0/0 |
| pypi:httpx@0.28.1 | 25 | 182 | 0 | 0 | 0/0 |
| pypi:anthropic@2.3.0 | 7 | 24 | 0 | 1 | 0/0 |
| pypi:openai@3.39.0 | 20 | 186 | 0 | 1 | 0/0 |
| pypi:langchain@1.4.7 | 21 | 285 | 0 | 1 | 0/0 |
| pypi:transformers@5.21.0 | 45 | 509 | 0 | 1 | 0/0 |
| pypi:sqlalchemy@2.1.6 | 45 | 840 | 0 | 0 | 0/0 |
| pypi:boto3@1.43.119 | 42 | 714 | 0 | 4 | 0/0 |
| pypi:pandas@3.1.0 | 45 | 399 | 0 | 1 | 0/0 |
| pypi:pytest@9.1.1 | 45 | 424 | 0 | 0 | 0/0 |

| upgrade | answer chars | removed | warned |
|---|---|---|---|
| npm:next 14.2.0 -> 16.4.3 | 12414 | 0 | 0 |
| npm:zod 3.23.0 -> 4.6.7 | 11424 | 0 | 0 |
| npm:express 4.21.0 -> 5.3.0 | 5469 | 0 | 0 |
| pypi:pydantic 1.10.0 -> 1.10.26 | 2089 | 0 | 0 |
| pypi:langchain 0.2.0 -> 1.4.7 | 9875 | 0 | 0 |
| npm:openai 4.50.0 -> 7.45.0 | 10276 | 0 | 0 |

### Flagged chunks

| level | package | source | rules | excerpt |
|---|---|---|---|---|
| high | next@16.4.3 | Full Documentation | addresses-agent-with-action, addresses-ai-modal | When you start the command from an interactive terminal, it asks which installed agent to use. For a new agent session, you can also choose its model, reasoning effort, whether to  |
| high | ai@7.0.154 | docs/03-agents/02-building-agents.mdx | addresses-agent-with-action, you-are-the-ai, use-shell-tool, steer-install | Pass `experimental_sandbox` when an agent tool needs a command or code execution environment. The experimental sandbox is a per-call value, so provide it to `generate()`, `stream() |
| high | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | addresses-agent-with-action, addresses-ai-modal | Source: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli Scripting the MCP Inspector: methods, output formats, exit codes, and CI recipes Each CLI run connects t |
| high | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | secret-piped-out, reads-secret-file, destructive-action | Local MCP servers are binaries that are downloaded and executed on the same machine as the MCP client. Without proper sandboxing and consent requirements in place, the following at |
| medium | next@16.4.3 | Full Documentation | addresses-ai-note-for, addresses-ai-note-to | Learn more about the APIs and tools described in this guide. - Next.js MCP Server: Learn how to give coding agents access to your running Next.js app through the built-in MCP endpo |
| medium | next@16.4.3 | Full Documentation | addresses-ai-note-for, addresses-ai-note-to | \| Version \| Changes \| \| --------- \| -------------------------------------------------------- \| \| `v16.4.0` \| `experimental.agentFeedback` configuration option added. \| - A |
| medium | next@16.4.3 | Full Documentation | addresses-ai-note-for, addresses-ai-note-to | - adapterPath: Configure a custom adapter for Next.js to hook into the build process. - agentFeedback: Enable a review flow for Next.js issue reports prepared by AI coding agents.  |
| medium | prisma@7.10.1 | llms-full.txt | addresses-ai-modal | Create one client for a running application instance rather than opening a fresh pool for every request. Test your actual queries, transactions and data types against a development |
| medium | prisma@7.10.1 | llms-full.txt | tell-user-nothing | - **`The server does not support SSL connections` on a local database.** Many local setups run without TLS. Use `sslmode=disable` in the local `.env` only, and keep TLS settings in |
| medium | @anthropic-ai/sdk@1.3.0 | README.md | addresses-ai-vocative | ```js import Anthropic from '@anthropic-ai/sdk'; const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'], // This is the default and can be omitted }); const messag |
| medium | openai@7.45.0 | README.md | you-are-the-ai | The full API of this library can be found in [api.md file](api.md) along with many [code examples](https://github.com/openai/openai-node/tree/main/examples). The primary API for in |
| medium | ai@7.0.154 | docs/03-agents/06-subagents.mdx | consent-claimed | Subagent tools cannot use approval flows such as `toolApproval` (or the deprecated `needsApproval`). All tools must execute automatically without user confirmation. |
| medium | ai@7.0.154 | docs/03-agents/06-tool-approvals.mdx | consent-claimed, publish-or-push | Every approval rule returns one of these statuses, either as a string or as an object with a `type` field: - `'not-applicable'`: execute the tool normally without approval metadata |
| medium | langchain@1.5.19 | langchainjs/AGENTS.md@langchain@1.5.19 | addresses-ai-note-for | This document provides guidance for AI coding agents working with the LangChain.js codebase. <corridor> |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | addresses-ai-label, addresses-ai-line | Here's a high-level workflow schema: ```mermaid theme={null} --- config: theme: neutral --- sequenceDiagram actor User participant Client participant Claude participant MCP_Server  |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | addresses-ai-modal | Follow the authentication prompts provided by the server. This may redirect you to a third-party authentication provider or display a form within Claude. Once authentication is com |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | addresses-ai-modal | Resources expose data from files, APIs, databases, or any other source that an AI needs to understand context. Applications can access this information directly and decide how to u |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | consent-claimed | Attackers can exploit MCP servers acting as intermediaries to third-party APIs, leading to confused deputy vulnerabilities. By using stolen authorization codes, they can obtain acc |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | consent-claimed | 1. **User Consent and Control** * Users must explicitly consent to and understand all data access and operations * Users must retain control over what data is shared and what actio |
| medium | @modelcontextprotocol/sdk@1.32.2 | llms-full.txt | addresses-ai-note-for | A discovery result includes: * `supportedVersions`: Protocol versions the server supports. The client should choose one of these for subsequent requests. * `capabilities`: Capabili |
| medium | fastapi@0.162.0 | fastapi/docs/en/docs/_llm-test.md@0.162.0 | addresses-ai-modal | * <abbr title="Mozilla Developer Network: documentation for developers, written by the Firefox people">MDN</abbr> * <abbr title="Input/Output: disk reading or writing, network comm |
| medium | anthropic@2.3.0 | anthropic-sdk-python/README.md@v2.3.0 | addresses-ai-vocative | ```python import os from anthropic import Anthropic client = Anthropic( api_key=os.environ.get("ANTHROPIC_API_KEY"), # This is the default and can be omitted ) message = client.mes |
| medium | openai@3.39.0 | openai-python/README.md@v3.39.0 | you-are-the-ai | The full API of this library can be found in [api.md](api.md). The primary API for interacting with OpenAI models is the [Responses API](https://developers.openai.com/api/reference |
| medium | langchain@1.4.7 | langchain-ai/docs/src/oss/python/integrations/providers/langchain_decorators.mdx (docs repo, default branch) | addresses-ai-modal | If we want to leverage streaming: - we need to define prompt as async function - turn on the streaming on the decorator, or we can define PromptType with streaming on - capture the |
| medium | transformers@5.21.0 | transformers/docs/source/en/chat_response_parsing.md (default branch) | fake-tool-call, chat-template-token, steer-install | The best way to understand how to write a response template is to pick a concrete example. Here's what a raw reply from `SmolLM` might look like: ```txt <think> I should greet the  |
| medium | boto3@1.43.119 | llms-full.txt | addresses-ai-note-for | - [Guidance for Agentic Data Exploration on AWS](https://docs.aws.amazon.com/solutions/agentic-data-exploration-on-aws/index.md): This Guidance demonstrates how to overcome data fr |
| medium | boto3@1.43.119 | llms-full.txt | addresses-ai-note-for | - [Guidance for AI-Assisted Call Center Representative Training on AWS](https://docs.aws.amazon.com/solutions/ai-assisted-call-center-representative-training-on-aws/index.md): This |
| medium | boto3@1.43.119 | llms-full.txt | addresses-ai-note-for | - [Guidance for an AI-Powered Studio on AWS](https://docs.aws.amazon.com/solutions/ai-powered-studio-on-aws/index.md): This Guidance helps studios create cinematic-level AI-generat |
| medium | boto3@1.43.119 | llms-full.txt | addresses-ai-note-for | - [Guidance for CDK Construct Compatibility Testing using Amazon Bedrock AgentCore](https://docs.aws.amazon.com/solutions/cdk-construct-compatibility-testing-using-amazon-bedrock-a |
| medium | pandas@3.1.0 | pandas/doc/source/development/maintaining.rst@v3.1.0 | consent-claimed, publish-or-push | Only core team members can merge pull requests. We have a few guidelines. 1. You should typically not self-merge your own pull requests without approval. Exceptions include things  |

## Detection on the adversarial corpus

test/fixtures/injection/cases.ts: 61 crafted passages (README, docs, docstrings, .d.ts comments, changelog and release entries, deprecation messages, descriptions, llms.txt).

- Flagged: **61/61**; at the expected level (high = dropped, medium = warned): **61/61**; high: 52.
- Hard negatives (installers piped to sh, API-key docs, chat templates, security docs quoting attacks): 0/41 flagged.

The corpus was written together with the rules, so this is a regression floor, not an unbiased detection rate; see bench/injection/heldout.ts for passages written after the rules were frozen.
