import fs from 'fs';
import os from 'os';
import path from 'path';

type PathModule = typeof path.posix;

// Remote files SFTP must never write, even on unrestricted connections — the
// same intent as the ssh_exec blocklist (account takeover / backdoor targets).
const PROTECTED_REMOTE_WRITES: RegExp[] = [
  /^\/etc\/(passwd|shadow|gshadow|group)$/,
  /^\/etc\/sudoers(\.d(\/.*)?)?$/,
  /\/\.ssh\/authorized_keys2?$/,
];

/** True when `target` is `root` itself or inside it. Case-insensitive on Windows via path.win32.relative. */
export function isWithin(p: PathModule, root: string, target: string): boolean {
  const rel = p.relative(root, target);
  return rel === '' || (rel.split(p.sep)[0] !== '..' && !p.isAbsolute(rel));
}

export function checkRemoteWrite(remotePath: string): string | undefined {
  if (PROTECTED_REMOTE_WRITES.some((re) => re.test(remotePath))) {
    return `Writing to "${remotePath}" is blocked: it is a protected system/credential file`;
  }
  return undefined;
}

export function checkRoots(p: PathModule, target: string, roots: string[] | undefined, label: string): string | undefined {
  if (!roots || roots.length === 0) return undefined;
  if (roots.some((root) => isWithin(p, root, target))) return undefined;
  return `"${target}" is outside this connection's ${label} (${roots.join(', ')})`;
}

/** Local paths that are always off-limits: SSH keys, this server's state dir, and any extra (config file, secret files). */
export function checkLocalProtected(target: string, extra: string[]): string | undefined {
  const protectedPaths = [path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.remote-context-mcp'), ...extra];
  const hit = protectedPaths.map((p) => resolveLocal(p)).find((p) => isWithin(path, p, target) || isWithin(path, target, p));
  return hit ? `Local path "${target}" is blocked: it is or contains a protected file (${hit})` : undefined;
}

/**
 * Absolute, symlink-resolved local path. For paths that don't exist yet, resolves
 * the nearest existing ancestor and re-appends the rest — so a symlinked parent
 * can't be used to escape a root.
 */
export function resolveLocal(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(p);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Remote counterpart of resolveLocal, using the server's realpath. Relative paths resolve against the login directory. */
export async function resolveRemote(realpath: (p: string) => Promise<string>, p: string): Promise<string> {
  const base = p.startsWith('/') ? '/' : await realpath('.');
  let existing = path.posix.resolve(base, p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.posix.join(await realpath(existing), ...rest);
    } catch {
      if (existing === '/') return path.posix.resolve(base, p);
      rest.unshift(path.posix.basename(existing));
      existing = path.posix.dirname(existing);
    }
  }
}
