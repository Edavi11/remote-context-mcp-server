import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectionManager } from '../services/connection-manager.js';
import { filterCommand } from '../services/command-filter.js';
import { processTracker } from '../services/process-tracker.js';

export function registerCommandTools(server: McpServer): void {
  server.registerTool(
    'ssh_exec',
    {
      title: 'Execute SSH Command',
      description: `Executes a shell command on a remote server via SSH.

IMPORTANT: This tool will show the user the command being executed and ask for confirmation before running it. Dangerous commands are blocked automatically.

Use async=true for long-running commands (builds, migrations, log tailing, etc.) — the tool returns immediately with a process_id you can track with ssh_get_process.

Use async=false (default) for quick commands where you need the result immediately.`,
      inputSchema: {
        connection_name: z.string().describe('Name of the SSH connection to use (from ssh_list_connections)'),
        command: z.string().describe('Shell command to execute on the remote server'),
        working_directory: z.string().optional().describe('Directory to run the command in (optional)'),
        timeout_seconds: z.number().int().min(1).max(3600).optional().default(30).describe('Seconds before the command is killed (default: 30, max: 3600)'),
        async: z.boolean().optional().default(false).describe('If true, returns immediately with a process_id without waiting for the command to finish'),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ connection_name, command, working_directory, timeout_seconds, async: isAsync }) => {
      // Validate connection exists
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

      // Filter dangerous commands
      const filterResult = filterCommand(command);
      if (!filterResult.allowed) {
        const blockedRecord = processTracker.createBlocked({
          connection_name,
          command,
          working_directory,
          timeout_seconds: timeout_seconds ?? 30,
          blocked_reason: filterResult.reason!,
        });

        return {
          content: [
            {
              type: 'text',
              text: [
                `Command blocked [${filterResult.severity?.toUpperCase()}]`,
                `Reason: ${filterResult.reason}`,
                `Command: ${command}`,
                `Process ID: ${blockedRecord.id} (status: blocked)`,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }

      const resolvedTimeout = timeout_seconds ?? 30;
      const resolvedAsync = isAsync ?? false;

      const process_id = await connectionManager.execTracked(connection_name, command, {
        working_directory,
        timeout_seconds: resolvedTimeout,
        async: resolvedAsync,
      });

      if (resolvedAsync) {
        return {
          content: [
            {
              type: 'text',
              text: [
                `Command started asynchronously on "${connection_name}" (${config.host}).`,
                `Process ID: ${process_id}`,
                `Command: ${command}`,
                working_directory ? `Directory: ${working_directory}` : '',
                `Timeout: ${resolvedTimeout}s`,
                '',
                `Use ssh_get_process with process_id="${process_id}" to check status and output.`,
              ].filter(Boolean).join('\n'),
            },
          ],
        };
      }

      const record = processTracker.get(process_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: 'Process record not found after execution.' }],
          isError: true,
        };
      }

      const lines: string[] = [
        `Process ID: ${record.id}`,
        `Status: ${record.status}`,
        `Exit code: ${record.exit_code ?? 'N/A'}`,
        `Duration: ${record.duration_ms}ms`,
        `Server: ${connection_name} (${config.host})`,
        `Command: ${record.command}`,
        working_directory ? `Directory: ${working_directory}` : '',
        '',
      ].filter((l) => l !== undefined);

      if (record.stdout) {
        lines.push('--- STDOUT ---');
        lines.push(record.stdout);
      }
      if (record.stderr) {
        lines.push('--- STDERR ---');
        lines.push(record.stderr);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: record.status === 'failed' || record.status === 'timeout',
      };
    }
  );

  server.registerTool(
    'ssh_get_process',
    {
      title: 'Get SSH Process Status',
      description:
        'Retrieves the full status and output of a previously executed SSH command by its process ID. Use this to track long-running commands started with async=true, or to review the output of any past command.',
      inputSchema: {
        process_id: z.string().describe('The process ID returned by ssh_exec'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ process_id }) => {
      const record = processTracker.get(process_id);

      if (!record) {
        return {
          content: [
            {
              type: 'text',
              text: `Process "${process_id}" not found. Process records are kept in memory for the duration of the MCP server session.`,
            },
          ],
          isError: true,
        };
      }

      const config = connectionManager.getConfig(record.connection_name);

      const lines: string[] = [
        `Process ID: ${record.id}`,
        `Status: ${record.status}`,
        `Connection: ${record.connection_name}${config ? ` (${config.host})` : ''}`,
        `Command: ${record.command}`,
        record.working_directory ? `Directory: ${record.working_directory}` : '',
        `Started: ${record.started_at}`,
        record.finished_at ? `Finished: ${record.finished_at}` : 'Still running...',
        record.duration_ms !== undefined ? `Duration: ${record.duration_ms}ms` : '',
        record.exit_code !== undefined ? `Exit code: ${record.exit_code}` : '',
        record.blocked_reason ? `Blocked reason: ${record.blocked_reason}` : '',
        `Timeout: ${record.timeout_seconds}s`,
        '',
      ].filter(Boolean);

      if (record.stdout) {
        lines.push('--- STDOUT ---');
        lines.push(record.stdout);
      } else {
        lines.push('--- STDOUT ---');
        lines.push('(empty)');
      }

      if (record.stderr) {
        lines.push('--- STDERR ---');
        lines.push(record.stderr);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: record.status === 'failed' || record.status === 'timeout' || record.status === 'blocked',
      };
    }
  );

  server.registerTool(
    'ssh_list_processes',
    {
      title: 'List SSH Processes',
      description:
        'Lists all SSH command executions recorded in this session. Returns metadata only (no stdout/stderr) for a compact overview. Filter by connection name or status. Use ssh_get_process to see full output for a specific process.',
      inputSchema: {
        connection_name: z.string().optional().describe('Filter by connection name (optional)'),
        status: z
          .enum(['running', 'completed', 'failed', 'timeout', 'blocked'])
          .optional()
          .describe('Filter by process status (optional)'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ connection_name, status }) => {
      const processes = processTracker.list({
        connection_name: connection_name ?? undefined,
        status: status ?? undefined,
      });

      if (processes.length === 0) {
        const filterDesc = [
          connection_name ? `connection="${connection_name}"` : '',
          status ? `status="${status}"` : '',
        ]
          .filter(Boolean)
          .join(', ');

        return {
          content: [
            {
              type: 'text',
              text: filterDesc
                ? `No processes found matching filters: ${filterDesc}`
                : 'No processes recorded in this session yet.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(processes, null, 2),
          },
        ],
      };
    }
  );
}
