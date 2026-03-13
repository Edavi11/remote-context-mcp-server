import { z } from 'zod';

export const SSHConnectionConfigSchema = z.object({
  name: z.string().min(1, 'Connection name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1, 'Username is required'),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
}).refine(
  (data) => data.password !== undefined || data.privateKeyPath !== undefined,
  { message: 'Either password or privateKeyPath must be provided' }
);

export const SSHConnectionsEnvSchema = z.array(SSHConnectionConfigSchema).min(1, 'At least one SSH connection is required');

export const SshExecInputSchema = z.object({
  connection_name: z.string().min(1, 'Connection name is required'),
  command: z.string().min(1, 'Command is required'),
  working_directory: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional().default(30),
  async: z.boolean().optional().default(false),
});

export const SshPingInputSchema = z.object({
  connection_name: z.string().min(1, 'Connection name is required'),
});

export const SshGetProcessInputSchema = z.object({
  process_id: z.string().min(1, 'Process ID is required'),
});

export const SshListProcessesInputSchema = z.object({
  connection_name: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'timeout', 'blocked']).optional(),
});
