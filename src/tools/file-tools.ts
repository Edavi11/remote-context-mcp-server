import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { uploadFile, downloadFile, listRemoteDir, TransferResult } from '../services/sftp-service.js';

function errorResult(prefix: string, err: unknown) {
  return { content: [{ type: 'text' as const, text: `${prefix}: ${(err as Error).message}` }], isError: true };
}

function summarize(verb: string, from: string, to: string, r: TransferResult): string {
  return [
    `${verb} "${from}" → "${to}"`,
    `Files: ${r.files} | Bytes: ${r.bytes} | Duration: ${r.duration_ms}ms`,
    r.skipped.length ? `Skipped (symlinks/special files): ${r.skipped.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

const connectionName = z.string().describe('Name of the SSH connection to use (from ssh_list_connections)');
const recursive = z.boolean().optional().default(false).describe('Required to transfer a directory (copied with all its contents)');
const overwrite = z.boolean().optional().default(false).describe('Replace the destination if it already exists (default: false — refuses instead)');

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'ssh_upload_file',
    {
      title: 'Upload File via SFTP',
      description:
        'Uploads a local file or directory to a remote server over SFTP, reusing the pooled SSH connection. remote_path is the full destination path (not the parent directory); missing parent directories are created. Respects the connection\'s remoteRoots/localRoots and never writes protected files (/etc/passwd, /etc/shadow, sudoers, authorized_keys).',
      inputSchema: {
        connection_name: connectionName,
        local_path: z.string().describe('Path to the local file or directory to upload'),
        remote_path: z.string().describe('Full destination path on the remote server (relative paths resolve against the login directory)'),
        recursive,
        overwrite,
      },
      annotations: { destructiveHint: true },
    },
    async ({ connection_name, local_path, remote_path, recursive, overwrite }) => {
      try {
        const r = await uploadFile(connection_name, local_path, remote_path, { recursive, overwrite });
        return { content: [{ type: 'text', text: summarize('Uploaded', r.local_path, `${connection_name}:${r.remote_path}`, r) }] };
      } catch (err) {
        return errorResult('Upload failed', err);
      }
    }
  );

  server.registerTool(
    'ssh_download_file',
    {
      title: 'Download File via SFTP',
      description:
        'Downloads a file or directory from a remote server to the local machine over SFTP, reusing the pooled SSH connection. local_path is the full destination path; missing parent directories are created. Symlinks inside downloaded directories are skipped.',
      inputSchema: {
        connection_name: connectionName,
        remote_path: z.string().describe('Path to the file or directory on the remote server'),
        local_path: z.string().describe('Full destination path on the local machine'),
        recursive,
        overwrite,
      },
      annotations: { destructiveHint: true },
    },
    async ({ connection_name, remote_path, local_path, recursive, overwrite }) => {
      try {
        const r = await downloadFile(connection_name, remote_path, local_path, { recursive, overwrite });
        return { content: [{ type: 'text', text: summarize('Downloaded', `${connection_name}:${r.remote_path}`, r.local_path, r) }] };
      } catch (err) {
        return errorResult('Download failed', err);
      }
    }
  );

  server.registerTool(
    'ssh_list_remote_dir',
    {
      title: 'List Remote Directory via SFTP',
      description:
        'Lists a remote directory over SFTP: name, type, size, permissions and modification time of each entry. Use it to explore before uploading or downloading.',
      inputSchema: {
        connection_name: connectionName,
        remote_path: z.string().optional().default('.').describe('Remote directory to list (default: the login directory)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ connection_name, remote_path }) => {
      try {
        const result = await listRemoteDir(connection_name, remote_path ?? '.');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult('List failed', err);
      }
    }
  );
}
