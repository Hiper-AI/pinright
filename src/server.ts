#!/usr/bin/env node
/**
 * pinright over stdio. Configure it in your agent as an MCP server:
 *   { "mcpServers": { "pinright": { "command": "npx", "args": ["-y", "pinright"] } } }
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp.js';

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; everything human goes to stderr.
  console.error('[pinright] ready on stdio');
}

main().catch((err) => {
  console.error('[pinright] fatal:', (err as Error).message);
  process.exit(1);
});
