import fs from 'fs';
import os from 'os';
import path from 'path';

export type HostVerification = 'new' | 'match' | 'mismatch';

function defaultStorePath(): string {
  return path.join(os.homedir(), '.remote-context-mcp', 'known_hosts.json');
}

class KnownHostsStore {
  private storePath: string;
  private fingerprints: Map<string, string> | undefined;

  constructor(storePath: string = process.env.KNOWN_HOSTS_PATH || defaultStorePath()) {
    this.storePath = storePath;
  }

  private load(): Map<string, string> {
    if (this.fingerprints) return this.fingerprints;

    this.fingerprints = new Map();
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        this.fingerprints.set(key, value);
      }
    } catch {
      // No store yet, or unreadable — start fresh.
    }
    return this.fingerprints;
  }

  private persist(): void {
    if (!this.fingerprints) return;
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(this.fingerprints);
    fs.writeFileSync(this.storePath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  verify(host: string, port: number, fingerprint: string): HostVerification {
    const fingerprints = this.load();
    const key = `${host}:${port}`;
    const known = fingerprints.get(key);

    if (!known) {
      fingerprints.set(key, fingerprint);
      this.persist();
      return 'new';
    }

    return known === fingerprint ? 'match' : 'mismatch';
  }
}

export const knownHostsStore = new KnownHostsStore();
