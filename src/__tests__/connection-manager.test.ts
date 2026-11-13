import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Fake ssh2: connections become ready immediately; tests drive each exec stream by hand.
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events');

  class FakeStderr extends EventEmitter {
    setEncoding() { return this; }
  }

  class FakeStream extends EventEmitter {
    stderr = new FakeStderr();
    signals: string[] = [];
    closed = false;
    constructor(public command: string) { super(); }
    setEncoding() { return this; }
    signal(name: string) { this.signals.push(name); }
    close() { this.closed = true; }
  }

  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];
    ended = false;
    streams: FakeStream[] = [];
    constructor() { super(); FakeClient.instances.push(this); }
    connect() { setImmediate(() => this.emit('ready')); }
    exec(command: string, cb: (err: Error | undefined, s: FakeStream) => void) {
      const s = new FakeStream(command);
      this.streams.push(s);
      setImmediate(() => cb(undefined, s));
    }
    end() { this.ended = true; this.emit('close'); }
  }

  return { Client: FakeClient };
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-manager-test-'));
const configPath = path.join(tmpDir, 'connections.json');
fs.writeFileSync(configPath, JSON.stringify([{ name: 'srv', host: 'h', username: 'u', password: 'p' }]));
process.env.REMOTE_CONTEXT_CONFIG = configPath;
process.env.SSH_POOL_IDLE_MS = '40';

const { connectionManager } = await import('../services/connection-manager.js');
const { processTracker } = await import('../services/process-tracker.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Client } = (await import('ssh2')) as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const latestClient = (): any => Client.instances[Client.instances.length - 1];

async function startAsync(command: string, timeout_seconds = 30) {
  const id = await connectionManager.execTracked('srv', command, { async: true, timeout_seconds });
  let stream;
  await vi.waitFor(() => {
    stream = latestClient()?.streams.find((s: { command: string }) => s.command === command);
    expect(stream).toBeDefined();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, stream: stream as any };
}

describe('connectionManager', () => {
  beforeEach(async () => {
    await sleep(60); // let the previous test's pooled client go idle and close
  });

  it('loads connections from the config file', () => {
    expect(connectionManager.configSource).toBe(configPath);
    expect(connectionManager.listConnections().map((c) => c.name)).toEqual(['srv']);
  });

  it('does not close a pooled client while a command is still running', async () => {
    const { id, stream } = await startAsync('long-build');
    const client = latestClient();

    await sleep(150); // well past SSH_POOL_IDLE_MS
    expect(client.ended).toBe(false);
    expect(processTracker.get(id)?.status).toBe('running');

    stream.emit('data', 'done');
    stream.emit('close', 0);
    await vi.waitFor(() => expect(processTracker.get(id)?.status).toBe('completed'));

    await sleep(150); // idle again → now it may be closed
    expect(client.ended).toBe(true);
  });

  it('marks a process killed by a signal as failed, not completed', async () => {
    const { id, stream } = await startAsync('oom-job');
    stream.emit('close', null, 'SIGKILL');
    await vi.waitFor(() => expect(processTracker.get(id)?.status).toBe('failed'));
    expect(processTracker.get(id)?.signal).toBe('SIGKILL');
    expect(processTracker.get(id)?.stderr).toContain('terminated by SIGKILL');
  });

  it('marks a channel closed without an exit status as failed', async () => {
    const { id, stream } = await startAsync('dropped');
    stream.emit('close');
    await vi.waitFor(() => expect(processTracker.get(id)?.status).toBe('failed'));
    expect(processTracker.get(id)?.stderr).toContain('connection closed before the command reported an exit status');
  });

  it('sends KILL to the remote process on timeout', async () => {
    const { id, stream } = await startAsync('sleep 999', 1);
    await vi.waitFor(() => expect(processTracker.get(id)?.status).toBe('timeout'), { timeout: 2000 });
    expect(stream.signals).toContain('KILL');
    expect(stream.closed).toBe(true);
  });

  it('killProcess signals the stream and marks the record killed', async () => {
    const { id, stream } = await startAsync('tail -f log');
    expect(connectionManager.killProcess(id)).toBe(true);
    expect(stream.signals).toContain('KILL');
    stream.emit('close'); // a late close must not overwrite the killed status
    await sleep(10);
    expect(processTracker.get(id)?.status).toBe('killed');
  });

  it('ping runs uname through exec and returns its output', async () => {
    const pending = connectionManager.ping('srv');
    let stream;
    await vi.waitFor(() => {
      stream = latestClient()?.streams.find((s: { command: string }) => s.command === 'uname -a');
      expect(stream).toBeDefined();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).emit('data', 'Linux test 6.1\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).emit('close', 0);
    expect(await pending).toMatchObject({ success: true, server_info: 'Linux test 6.1' });
  });

  it('ping reports unknown connections', async () => {
    expect((await connectionManager.ping('nope')).success).toBe(false);
  });
});
