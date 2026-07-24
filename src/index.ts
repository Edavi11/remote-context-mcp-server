#!/usr/bin/env node
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerConnectionTools } from './tools/connection-tools.js';
import { registerCommandTools } from './tools/command-tools.js';
import { registerFileTools } from './tools/file-tools.js';

function readVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const server = new McpServer({
  name: 'remote-context-mcp-server',
  version: readVersion(),
});

registerConnectionTools(server);
registerCommandTools(server);
registerFileTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[remote-context] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[remote-context] Fatal error:', err);
  process.exit(1);
});
