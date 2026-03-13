import { Client, ConnectConfig } from 'ssh2';
import fs from 'fs';
import { SSHConnectionConfig, ConnectionMeta, AuthType, ExecOptions } from '../types.js';
import { SSHConnectionsEnvSchema } from '../schemas/connection.js';
import { processTracker } from './process-tracker.js';

export interface ExecCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface RawExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

class ConnectionManager {
  private configs = new Map<string, SSHConnectionConfig>();

  constructor() {
    this.loadFromEnv();
  }

  private loadFromEnv(): void {
    const raw = process.env.SSH_CONNECTIONS;
    if (!raw) {
      console.error('[remote-context] SSH_CONNECTIONS env variable not set. No connections available.');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[remote-context] SSH_CONNECTIONS is not valid JSON. No connections loaded.');
      return;
    }

    const result = SSHConnectionsEnvSchema.safeParse(parsed);
    if (!result.success) {
      console.error('[remote-context] SSH_CONNECTIONS validation failed:', result.error.flatten().fieldErrors);
      return;
    }

    for (const config of result.data) {
      if (this.configs.has(config.name)) {
        console.error(`[remote-context] Duplicate connection name "${config.name}". Skipping.`);
        continue;
      }
      this.configs.set(config.name, config);
    }

    console.error(`[remote-context] Loaded ${this.configs.size} SSH connection(s).`);
  }

  private buildConnectConfig(config: SSHConnectionConfig): ConnectConfig {
    const base: ConnectConfig = {
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      readyTimeout: 10000,
    };

    if (config.privateKeyPath) {
      try {
        const keyContent = fs.readFileSync(config.privateKeyPath, 'utf-8');
        base.privateKey = keyContent;
        if (config.passphrase) {
          base.passphrase = config.passphrase;
        }
      } catch (err) {
        throw new Error(`Cannot read private key at "${config.privateKeyPath}": ${(err as Error).message}`);
      }
    } else if (config.password) {
      base.password = config.password;
    }

    return base;
  }

  listConnections(): ConnectionMeta[] {
    return Array.from(this.configs.values()).map((c) => ({
      name: c.name,
      host: c.host,
      port: c.port ?? 22,
      username: c.username,
      auth_type: (c.privateKeyPath ? 'key' : 'password') as AuthType,
    }));
  }

  getConfig(name: string): SSHConnectionConfig | undefined {
    return this.configs.get(name);
  }

  ping(name: string): Promise<{ success: boolean; latency_ms: number; server_info: string }> {
    const config = this.configs.get(name);
    if (!config) {
      return Promise.resolve({ success: false, latency_ms: 0, server_info: `Connection "${name}" not found` });
    }

    return new Promise((resolve) => {
      const client = new Client();
      const startTime = Date.now();

      const onError = (err: Error) => {
        resolve({ success: false, latency_ms: Date.now() - startTime, server_info: err.message });
      };

      client.on('ready', () => {
        const latency_ms = Date.now() - startTime;
        client.exec('uname -a', (err, stream) => {
          if (err) {
            client.end();
            resolve({ success: true, latency_ms, server_info: 'Connected (could not fetch server info)' });
            return;
          }
          let info = '';
          stream.on('data', (d: Buffer) => { info += d.toString(); });
          stream.stderr.on('data', (_d: Buffer) => {});
          stream.on('close', () => {
            client.end();
            resolve({ success: true, latency_ms, server_info: info.trim() });
          });
        });
      });

      client.on('error', onError);

      try {
        client.connect(this.buildConnectConfig(config));
      } catch (err) {
        resolve({ success: false, latency_ms: Date.now() - startTime, server_info: (err as Error).message });
      }
    });
  }

  exec(
    name: string,
    command: string,
    options: ExecOptions = {},
    callbacks: ExecCallbacks = {}
  ): Promise<RawExecResult> {
    const config = this.configs.get(name);
    if (!config) {
      return Promise.reject(new Error(`Connection "${name}" not found`));
    }

    const timeout_seconds = options.timeout_seconds ?? 30;
    const fullCommand = options.working_directory
      ? `cd ${options.working_directory} && ${command}`
      : command;

    return new Promise((resolve, reject) => {
      const client = new Client();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          fn();
        }
      };

      client.on('ready', () => {
        client.exec(fullCommand, (err, stream) => {
          if (err) {
            client.end();
            settle(() => reject(err));
            return;
          }

          timeoutHandle = setTimeout(() => {
            stream.destroy();
            client.end();
            settle(() => reject(new Error('TIMEOUT')));
          }, timeout_seconds * 1000);

          stream.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stdout += chunk;
            callbacks.onStdout?.(chunk);
          });

          stream.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;
            callbacks.onStderr?.(chunk);
          });

          stream.on('close', (code: number | null) => {
            client.end();
            settle(() => resolve({ stdout, stderr, exit_code: code ?? 0 }));
          });
        });
      });

      client.on('error', (err) => {
        settle(() => reject(err));
      });

      try {
        client.connect(this.buildConnectConfig(config));
      } catch (err) {
        settle(() => reject(err));
      }
    });
  }

  async execTracked(
    name: string,
    command: string,
    options: ExecOptions = {}
  ): Promise<string> {
    const timeout_seconds = options.timeout_seconds ?? 30;

    const record = processTracker.create({
      connection_name: name,
      command,
      working_directory: options.working_directory,
      timeout_seconds,
    });

    const run = async () => {
      try {
        const result = await this.exec(name, command, options, {
          onStdout: (data) => processTracker.appendStdout(record.id, data),
          onStderr: (data) => processTracker.appendStderr(record.id, data),
        });
        processTracker.complete(record.id, result.exit_code);
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'TIMEOUT') {
          processTracker.timeout(record.id);
        } else {
          processTracker.appendStderr(record.id, message);
          processTracker.complete(record.id, 1);
        }
      }
    };

    if (options.async) {
      run(); // fire and forget
    } else {
      await run();
    }

    return record.id;
  }
}

export const connectionManager = new ConnectionManager();
