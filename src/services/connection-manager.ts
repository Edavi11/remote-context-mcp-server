import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import fs from 'fs';
import { SSHConnectionConfig, ConnectionMeta, AuthType, ExecOptions } from '../types.js';
import { loadConfig } from './config-loader.js';
import { processTracker } from './process-tracker.js';
import { buildFullCommand } from './shell-utils.js';
import { knownHostsStore } from './known-hosts.js';

export interface ExecCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStream?: (stream: ClientChannel) => void;
}

export interface RawExecResult {
  /** null when the remote never reported an exit status (signal, dropped connection). */
  exit_code: number | null;
  signal?: string;
}

interface PooledClient {
  client: Client;
  /** Channels (exec/sftp) currently using this client — the idle timer only runs at 0. */
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const POOL_IDLE_MS = Number(process.env.SSH_POOL_IDLE_MS) || 5 * 60 * 1000;
const PING_TIMEOUT_SECONDS = 10;

/** Best-effort remote kill: the signal extension isn't supported by every server, closing the channel always cuts it locally. */
function terminate(stream: ClientChannel): void {
  try {
    stream.signal('KILL');
  } catch {
    // ignore — see above
  }
  stream.close();
}

class ConnectionManager {
  private configs = new Map<string, SSHConnectionConfig>();
  private pool = new Map<string, PooledClient>();
  private connecting = new Map<string, Promise<Client>>();
  private activeStreams = new Map<string, ClientChannel>();
  readonly configSource: string;
  readonly configError?: string;

  constructor() {
    const loaded = loadConfig();
    this.configSource = loaded.source;
    this.configError = loaded.error;
    for (const config of loaded.connections) this.configs.set(config.name, config);

    if (loaded.error) console.error(`[remote-context] ${loaded.error}`);
    else console.error(`[remote-context] Loaded ${this.configs.size} SSH connection(s) from ${loaded.source}.`);
  }

  private buildConnectConfig(config: SSHConnectionConfig): ConnectConfig {
    const host = config.host;
    const port = config.port ?? 22;

    const base: ConnectConfig = {
      host,
      port,
      username: config.username,
      readyTimeout: 10000,
      // Keeps long-running jobs alive through NATs/firewalls that drop idle TCP sessions.
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
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
        base.privateKey = fs.readFileSync(config.privateKeyPath, 'utf-8');
      } catch (err) {
        throw new Error(`Cannot read private key at "${config.privateKeyPath}": ${(err as Error).message}`);
      }

      const passphrase = this.readSecret('passphrase', config.passphrase, config.passphraseFile);
      if (passphrase) base.passphrase = passphrase;
    } else {
      const password = this.readSecret('password', config.password, config.passwordFile);
      if (password) base.password = password;
    }

    return base;
  }

  /** Reads a secret from an inline value or, preferably, a file (kept outside the config). */
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

  private startIdleTimer(name: string, entry: PooledClient): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.active > 0) return;
      entry.client.end();
      this.removeFromPool(name, entry.client);
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
    if (pooled) return Promise.resolve(pooled.client);

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

        const entry: PooledClient = { client, active: 0 };
        this.pool.set(name, entry);
        this.startIdleTimer(name, entry);

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

  /**
   * Runs `fn` with a pooled, ready client and keeps that client out of idle
   * eviction until `fn` settles — so long commands and transfers aren't cut off.
   */
  async withClient<T>(name: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`Connection "${name}" not found`);

    const client = await this.getClient(name, config);
    const entry = this.pool.get(name);
    const tracked = entry?.client === client ? entry : undefined;
    if (tracked) {
      tracked.active++;
      if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
    }

    try {
      return await fn(client);
    } finally {
      if (tracked) {
        tracked.active--;
        if (tracked.active === 0 && this.pool.get(name) === tracked) this.startIdleTimer(name, tracked);
      }
    }
  }

  /** Best-effort cancellation of a running remote process by its tracked process_id. */
  killProcess(process_id: string): boolean {
    const stream = this.activeStreams.get(process_id);
    if (!stream) return false;

    this.activeStreams.delete(process_id);
    processTracker.kill(process_id);
    terminate(stream);
    return true;
  }

  listConnections(): ConnectionMeta[] {
    return Array.from(this.configs.values()).map((c) => ({
      name: c.name,
      host: c.host,
      port: c.port ?? 22,
      username: c.username,
      auth_type: (c.privateKeyPath ? 'key' : 'password') as AuthType,
      restricted: Boolean(c.allowedCommands?.length),
      remote_roots: c.remoteRoots,
      local_roots: c.localRoots,
    }));
  }

  getConfig(name: string): SSHConnectionConfig | undefined {
    return this.configs.get(name);
  }

  /** Local files SFTP must never read or overwrite: keys, secrets, this server's own state. */
  protectedLocalPaths(): string[] {
    const paths = Array.from(this.configs.values()).flatMap((c) =>
      [c.privateKeyPath, c.passwordFile, c.passphraseFile].filter((p): p is string => Boolean(p))
    );
    if (this.configSource !== 'SSH_CONNECTIONS' && this.configSource !== 'none') paths.push(this.configSource);
    return paths;
  }

  async ping(name: string): Promise<{ success: boolean; latency_ms: number; server_info: string }> {
    if (!this.configs.has(name)) {
      return { success: false, latency_ms: 0, server_info: `Connection "${name}" not found` };
    }

    const startTime = Date.now();
    let info = '';
    try {
      await this.exec(name, 'uname -a', { timeout_seconds: PING_TIMEOUT_SECONDS }, { onStdout: (d) => { info += d; } });
      return { success: true, latency_ms: Date.now() - startTime, server_info: info.trim() || 'Connected' };
    } catch (err) {
      const message = (err as Error).message;
      return {
        success: false,
        latency_ms: Date.now() - startTime,
        server_info: message === 'TIMEOUT' ? `No response within ${PING_TIMEOUT_SECONDS}s` : message,
      };
    }
  }

  exec(name: string, command: string, options: ExecOptions = {}, callbacks: ExecCallbacks = {}): Promise<RawExecResult> {
    const timeout_seconds = options.timeout_seconds ?? 30;
    const fullCommand = buildFullCommand(command, options.working_directory);

    return this.withClient(name, (client) => new Promise<RawExecResult>((resolve, reject) => {
      client.exec(fullCommand, (err, stream) => {
        if (err) return reject(err);

        // Decode as UTF-8 at the stream level so multi-byte chars split across chunks survive.
        stream.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        callbacks.onStream?.(stream);

        const timeoutHandle = setTimeout(() => {
          terminate(stream);
          reject(new Error('TIMEOUT'));
        }, timeout_seconds * 1000);

        stream.on('data', (chunk: string) => callbacks.onStdout?.(chunk));
        stream.stderr.on('data', (chunk: string) => callbacks.onStderr?.(chunk));
        stream.on('close', (code?: number | null, signal?: string) => {
          clearTimeout(timeoutHandle);
          resolve({ exit_code: typeof code === 'number' ? code : null, signal: signal || undefined });
        });
      });
    }));
  }

  async execTracked(name: string, command: string, options: ExecOptions = {}): Promise<string> {
    const timeout_seconds = options.timeout_seconds ?? 30;

    const record = processTracker.create({
      connection_name: name,
      command,
      working_directory: options.working_directory,
      timeout_seconds,
    });

    const run = async () => {
      try {
        const { exit_code, signal } = await this.exec(name, command, options, {
          onStdout: (data) => processTracker.appendStdout(record.id, data),
          onStderr: (data) => processTracker.appendStderr(record.id, data),
          onStream: (stream) => this.activeStreams.set(record.id, stream),
        });
        if (exit_code === null) {
          processTracker.appendStderr(
            record.id,
            signal ? `\n[terminated by ${signal}]` : '\n[connection closed before the command reported an exit status]'
          );
        }
        processTracker.complete(record.id, exit_code, signal);
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'TIMEOUT') {
          processTracker.timeout(record.id);
        } else {
          processTracker.appendStderr(record.id, message);
          processTracker.complete(record.id, null);
        }
      } finally {
        this.activeStreams.delete(record.id);
      }
    };

    if (options.async) {
      void run(); // fire and forget — run() never rejects
    } else {
      await run();
    }

    return record.id;
  }
}

export const connectionManager = new ConnectionManager();
