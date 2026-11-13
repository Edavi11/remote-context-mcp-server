import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isWithin, checkRemoteWrite, checkRoots, checkLocalProtected, resolveLocal, resolveRemote } from '../services/path-policy.js';

describe('isWithin', () => {
  it('accepts the root itself and its children', () => {
    expect(isWithin(path.posix, '/opt/app', '/opt/app')).toBe(true);
    expect(isWithin(path.posix, '/opt/app', '/opt/app/src/x.ts')).toBe(true);
  });

  it('rejects siblings, parents and prefix look-alikes', () => {
    expect(isWithin(path.posix, '/opt/app', '/opt')).toBe(false);
    expect(isWithin(path.posix, '/opt/app', '/opt/app2/x')).toBe(false);
    expect(isWithin(path.posix, '/opt/app', '/etc/passwd')).toBe(false);
  });

  it('accepts names that merely start with dots', () => {
    expect(isWithin(path.posix, '/opt/app', '/opt/app/..hidden')).toBe(true);
  });
});

describe('checkRoots', () => {
  it('allows anything when no roots are configured', () => {
    expect(checkRoots(path.posix, '/etc/x', undefined, 'remoteRoots')).toBeUndefined();
  });

  it('blocks paths outside every root', () => {
    expect(checkRoots(path.posix, '/etc/x', ['/opt/app', '/var/log'], 'remoteRoots')).toMatch(/outside/);
    expect(checkRoots(path.posix, '/var/log/nginx/a.log', ['/opt/app', '/var/log'], 'remoteRoots')).toBeUndefined();
  });
});

describe('checkRemoteWrite', () => {
  it.each(['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/sudoers.d/90-x', '/root/.ssh/authorized_keys', '/home/u/.ssh/authorized_keys2'])(
    'blocks %s',
    (p) => expect(checkRemoteWrite(p)).toMatch(/protected/)
  );

  it.each(['/etc/nginx/nginx.conf', '/home/u/.ssh/config', '/opt/app/passwd'])('allows %s', (p) => {
    expect(checkRemoteWrite(p)).toBeUndefined();
  });
});

describe('checkLocalProtected', () => {
  it('blocks ~/.ssh and anything inside it', () => {
    expect(checkLocalProtected(path.join(os.homedir(), '.ssh', 'id_rsa'), [])).toMatch(/protected/);
  });

  it('blocks a directory that contains a protected path (e.g. uploading the whole home dir)', () => {
    expect(checkLocalProtected(resolveLocal(os.homedir()), [])).toMatch(/protected/);
  });

  it('blocks extra protected files such as the config file', () => {
    const cfg = path.join(os.tmpdir(), 'cfg-protected.json');
    expect(checkLocalProtected(resolveLocal(cfg), [cfg])).toMatch(/protected/);
  });

  it('allows ordinary paths', () => {
    expect(checkLocalProtected(resolveLocal(path.join(os.tmpdir(), 'build.zip')), [])).toBeUndefined();
  });
});

describe('resolveLocal', () => {
  it('normalizes traversal and keeps non-existent tails', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-local-'));
    const resolved = resolveLocal(path.join(base, 'a', '..', 'b', 'new.txt'));
    expect(resolved).toBe(path.join(fs.realpathSync.native(base), 'b', 'new.txt'));
  });
});

describe('resolveRemote', () => {
  // Fake server: /home/u is the login dir, /data/link is a symlink to /etc, only these exist.
  const existing: Record<string, string> = { '.': '/home/u', '/': '/', '/home': '/home', '/home/u': '/home/u', '/data': '/data', '/data/link': '/etc', '/etc': '/etc' };
  const realpath = async (p: string) => {
    if (p in existing) return existing[p];
    throw new Error('No such file');
  };

  it('resolves relative paths against the login directory', async () => {
    expect(await resolveRemote(realpath, 'app/x.txt')).toBe('/home/u/app/x.txt');
  });

  it('collapses ../ before checking', async () => {
    expect(await resolveRemote(realpath, '/home/u/../../etc/passwd')).toBe('/etc/passwd');
  });

  it('follows symlinked parents so roots cannot be escaped', async () => {
    expect(await resolveRemote(realpath, '/data/link/shadow')).toBe('/etc/shadow');
  });
});
