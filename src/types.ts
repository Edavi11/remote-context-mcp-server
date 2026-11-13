export interface SSHConnectionConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  passwordFile?: string;
  privateKeyPath?: string;
  passphrase?: string;
  passphraseFile?: string;
  allowedCommands?: string[];
  remoteRoots?: string[];
  localRoots?: string[];
}

export type ProcessStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'blocked' | 'killed';

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
  signal?: string;
  timeout_seconds: number;
  blocked_reason?: string;
}

export interface ConnectionMeta {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  restricted: boolean;
  remote_roots?: string[];
  local_roots?: string[];
}

export interface ExecOptions {
  working_directory?: string;
  timeout_seconds?: number;
  async?: boolean;
}
