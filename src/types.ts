export interface SSHConnectionConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export type ProcessStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'blocked';

export type AuthType = 'password' | 'key';

export interface ProcessRecord {
  id: string;
  connection_name: string;
  command: string;
  working_directory?: string;
  status: ProcessStatus;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  stdout: string;
  stderr: string;
  exit_code?: number;
  timeout_seconds: number;
  blocked_reason?: string;
}

export interface ConnectionMeta {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
}

export interface ExecOptions {
  working_directory?: string;
  timeout_seconds?: number;
  async?: boolean;
}

export interface ExecResult {
  process_id: string;
  status: ProcessStatus;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
  message?: string;
}
