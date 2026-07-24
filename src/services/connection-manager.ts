import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import fs from 'fs';
import { SSHConnectionConfig, ConnectionMeta, AuthType, ExecOptions } from '../types.js';
import { SSHConnectionsEnvSchema } from '../schemas/connection.js';
import { processTracker } from './process-tracker.js';
import { buildFullCommand } from './shell-utils.js';
import { knownHostsStore } from './known-hosts.js';

export interface ExecCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStream?: (stream: ClientChannel) => void;
}

export interface RawExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface PooledClient {
  client: Client;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const POOL_IDLE_MS = Number(process.env.SSH_POOL_IDLE_MS) || 5 * 60 * 1000;

class ConnectionManager {
  private configs = new Map<string, SSHConnectionConfig>();
  private pool = new Map<string, PooledClient>();
  private connecting = new Map<string, Promise<Client>>();
  private activeStreams = new Map<string, ClientChannel>();

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
    const host = config.host;
    const port = config.port ?? 22;

    const base: ConnectConfig = {
      host,
      port,
      username: config.username,
      readyTimeout: 10000,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => {
        const result = knownHostsStore.verify(host, port, fingerprint);
        if (result === 'mismatch') {
          console.error(
            `[remote-context] HOST KEY MISMATCH for ${host}:${port} — refusing to connect. ` +
              'This could mean the server was reconfigured, or a man-in-the-middle attack. ' +
              `If this is expected, remove the stale entry from the known_hosts store.`
          );
          return false;
        }
        return true;
      },
    };

    if (config.privateKeyPath) {
      try {
        const keyContent = fs.readFileSync(config.privateKeyPath, 'utf-8');
        base.privateKey = keyContent;
      } catch (err) {
        throw new Error(`Cannot read private key at "${config.privateKeyPath}": ${(err as Error).message}`);
      }

      const passphrase = this.readSecret('passphrase', config.passphrase, config.passphraseFile);
      if (passphrase) {
        base.passphrase = passphrase;
      }
    } else {
      const password = this.readSecret('password', config.password, config.passwordFile);
      if (password) {
        base.password = password;
      }
    }

    return base;
  }

  /** Reads a secret from an inline value or, preferably, a file (kept outside SSH_CONNECTIONS/env). */
  private readSecret(label: string, inlineValue?: string, filePath?: string): string | undefined {
    if (filePath) {
      try {
        return fs.readFileSync(filePath, 'utf-8').trim();
      } catch (err) {
        throw new Error(`Cannot read ${label} file at "${filePath}": ${(err as Error).message}`);
      }
    }
    return inlineValue;
  }

  private resetIdleTimer(name: string, entry: PooledClient): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.client.end();
      this.pool.delete(name);
    }, POOL_IDLE_MS);
    entry.idleTimer.unref?.();
  }

  private removeFromPool(name: string, client: Client): void {
    const entry = this.pool.get(name);
    if (entry && entry.client === client) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.pool.delete(name);
    }
  }

  private getClient(name: string, config: SSHConnectionConfig): Promise<Client> {
    const pooled = this.pool.get(name);
    if (pooled) {
      this.resetIdleTimer(name, pooled);
      return Promise.resolve(pooled.client);
    }

    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const connectPromise = new Promise<Client>((resolve, reject) => {
      const client = new Client();

      const onError = (err: Error) => {
        this.connecting.delete(name);
        reject(err);
      };

      client.once('ready', () => {
        client.removeListener('error', onError);
        this.connecting.delete(name);

        const entry: PooledClient = { client };
        this.pool.set(name, entry);
        this.resetIdleTimer(name, entry);

        client.on('close', () => this.removeFromPool(name, client));
        client.on('error', () => this.removeFromPool(name, client));

        resolve(client);
      });

      client.once('error', onError);

      try {
        client.connect(this.buildConnectConfig(config));
      } catch (err) {
        onError(err as Error);
      }
    });

    this.connecting.set(name, connectPromise);
    return connectPromise;
  }

  /** Best-effort cancellation of a running remote process by its tracked process_id. */
  killProcess(process_id: string): boolean {
    const stream = this.activeStreams.get(process_id);
    if (!stream) return false;

    this.activeStreams.delete(process_id);
    processTracker.kill(process_id);
    try {
      stream.signal('KILL');
    } catch {
      // Not all servers support the signal extension — closing the channel below still cuts it off locally.
    }
    stream.close();
    return true;
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

  /** Returns a ready, pooled ssh2 Client for the given connection — used by services (e.g. SFTP) that need direct access. */
  getReadyClient(name: string): Promise<Client> {
    const config = this.configs.get(name);
    if (!config) {
      return Promise.reject(new Error(`Connection "${name}" not found`));
    }
    return this.getClient(name, config);
  }

  async ping(name: string): Promise<{ success: boolean; latency_ms: number; server_info: string }> {
    const config = this.configs.get(name);
    if (!config) {
      return { success: false, latency_ms: 0, server_info: `Connection "${name}" not found` };
    }

    const startTime = Date.now();

    let client: Client;
    try {
      client = await this.getClient(name, config);
    } catch (err) {
      return { success: false, latency_ms: Date.now() - startTime, server_info: (err as Error).message };
    }

    const latency_ms = Date.now() - startTime;

    return new Promise((resolve) => {
      client.exec('uname -a', (err, stream) => {
        if (err) {
          resolve({ success: true, latency_ms, server_info: 'Connected (could not fetch server info)' });
          return;
        }
        let info = '';
        stream.on('data', (d: Buffer) => { info += d.toString(); });
        stream.stderr.on('data', (_d: Buffer) => {});
        stream.on('close', () => {
          resolve({ success: true, latency_ms, server_info: info.trim() });
        });
      });
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
    const fullCommand = buildFullCommand(command, options.working_directory);

    return new Promise((resolve, reject) => {
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

      this.getClient(name, config)
        .then((client) => {
          client.exec(fullCommand, (err, stream) => {
            if (err) {
              settle(() => reject(err));
              return;
            }

            callbacks.onStream?.(stream);

            timeoutHandle = setTimeout(() => {
              stream.destroy();
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
              settle(() => resolve({ stdout, stderr, exit_code: code ?? 0 }));
            });
          });
        })
        .catch((err) => settle(() => reject(err)));
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
          onStream: (stream) => this.activeStreams.set(record.id, stream),
        });
        this.activeStreams.delete(record.id);
        processTracker.complete(record.id, result.exit_code);
      } catch (err) {
        this.activeStreams.delete(record.id);
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
