import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectionManager } from '../services/connection-manager.js';
import { uploadFile, downloadFile } from '../services/sftp-service.js';

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'ssh_upload_file',
    {
      title: 'Upload File via SFTP',
      description: 'Uploads a local file to a remote server over SFTP, using an already-configured SSH connection.',
      inputSchema: {
        connection_name: z.string().describe('Name of the SSH connection to use (from ssh_list_connections)'),
        local_path: z.string().describe('Path to the local file to upload'),
        remote_path: z.string().describe('Destination path on the remote server'),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ connection_name, local_path, remote_path }) => {
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

      try {
        await uploadFile(connection_name, local_path, remote_path);
        return {
          content: [{ type: 'text', text: `Uploaded "${local_path}" to "${connection_name}:${remote_path}".` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Upload failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'ssh_download_file',
    {
      title: 'Download File via SFTP',
      description: 'Downloads a file from a remote server to the local machine over SFTP, using an already-configured SSH connection.',
      inputSchema: {
        connection_name: z.string().describe('Name of the SSH connection to use (from ssh_list_connections)'),
        remote_path: z.string().describe('Path to the file on the remote server'),
        local_path: z.string().describe('Destination path on the local machine'),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ connection_name, remote_path, local_path }) => {
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

      try {
        await downloadFile(connection_name, remote_path, local_path);
        return {
          content: [{ type: 'text', text: `Downloaded "${connection_name}:${remote_path}" to "${local_path}".` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Download failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
