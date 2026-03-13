import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectionManager } from '../services/connection-manager.js';

export function registerConnectionTools(server: McpServer): void {
  server.registerTool(
    'ssh_list_connections',
    {
      title: 'List SSH Connections',
      description:
        'Lists all configured SSH connections. Use this to discover available servers and their connection names before calling other tools. Does not expose passwords or private keys.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const connections = connectionManager.listConnections();

      if (connections.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No SSH connections configured. Set the SSH_CONNECTIONS environment variable with a JSON array of connection configs.',
            },
          ],
        };
      }

      const rows = connections.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port,
        username: c.username,
        auth_type: c.auth_type,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'ssh_ping',
    {
      title: 'Ping SSH Connection',
      description:
        'Tests connectivity to a remote server via SSH. Returns whether the connection succeeded, the latency in milliseconds, and basic server info (uname output). Use this to verify a connection is working before executing commands.',
      inputSchema: {
        connection_name: z.string().describe('The name of the SSH connection to test (as listed in ssh_list_connections)'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ connection_name }) => {
      const config = connectionManager.getConfig(connection_name);
      if (!config) {
        return {
          content: [
            {
              type: 'text',
              text: `Connection "${connection_name}" not found. Use ssh_list_connections to see available connections.`,
            },
          ],
          isError: true,
        };
      }

      const result = await connectionManager.ping(connection_name);

      const text = result.success
        ? `✓ Connected to "${connection_name}" (${config.host}:${config.port ?? 22})\nLatency: ${result.latency_ms}ms\nServer: ${result.server_info}`
        : `✗ Failed to connect to "${connection_name}" (${config.host}:${config.port ?? 22})\nError: ${result.server_info}`;

      return {
        content: [{ type: 'text', text }],
        isError: !result.success,
      };
    }
  );
}
