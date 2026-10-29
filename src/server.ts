#!/usr/bin/env node
/**
 * safectx over stdio. Configure it in your agent like Context7:
 *   { "mcpServers": { "safectx": { "command": "npx", "args": ["-y", "safectx"] } } }
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer } from './mcp.js';

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; everything human goes to stderr.
  console.error('[safectx] ready on stdio');
}

main().catch((err) => {
  console.error('[safectx] fatal:', (err as Error).message);
  process.exit(1);
});
