import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The store path is read once at module load from KNOWN_HOSTS_PATH, so we
// point it at an isolated temp file before importing the module under test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-hosts-test-'));
const storePath = path.join(tmpDir, 'known_hosts.json');
process.env.KNOWN_HOSTS_PATH = storePath;

const { knownHostsStore } = await import('../services/known-hosts.js');

describe('knownHostsStore', () => {
  afterEach(() => {
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  });

  it('trusts and stores a fingerprint on first connection (TOFU)', () => {
    const result = knownHostsStore.verify('example.com', 22, 'abc123');
    expect(result).toBe('new');
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it('matches on subsequent connections with the same fingerprint', () => {
    knownHostsStore.verify('example.com', 22, 'abc123');
    const result = knownHostsStore.verify('example.com', 22, 'abc123');
    expect(result).toBe('match');
  });

  it('flags a mismatch when the fingerprint changes', () => {
    knownHostsStore.verify('example.com', 22, 'abc123');
    const result = knownHostsStore.verify('example.com', 22, 'different-fingerprint');
    expect(result).toBe('mismatch');
  });

  it('tracks host:port independently', () => {
    knownHostsStore.verify('example.com', 22, 'abc123');
    const result = knownHostsStore.verify('example.com', 2222, 'abc123');
    expect(result).toBe('new');
  });
});
