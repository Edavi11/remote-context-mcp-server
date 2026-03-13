#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerConnectionTools } from './tools/connection-tools.js';
import { registerCommandTools } from './tools/command-tools.js';

const server = new McpServer({
  name: 'remote-context-mcp-server',
  version: '1.0.0',
});

registerConnectionTools(server);
registerCommandTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[remote-context] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[remote-context] Fatal error:', err);
  process.exit(1);
});
