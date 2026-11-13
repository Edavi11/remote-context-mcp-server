import fs from 'fs';
import path from 'path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { connectionManager } from './connection-manager.js';
import { auditLog } from './audit-log.js';
import { checkLocalProtected, checkRemoteWrite, checkRoots, resolveLocal, resolveRemote } from './path-policy.js';

const MAX_TRANSFER_FILES = Number(process.env.SFTP_MAX_FILES) || 5000;

export interface TransferOptions {
  recursive?: boolean;
  overwrite?: boolean;
}

export interface TransferResult {
  local_path: string;
  remote_path: string;
  files: number;
  bytes: number;
  skipped: string[];
  duration_ms: number;
}

export interface RemoteEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mode: string;
  modified: string;
}

/** Promise wrapper for ssh2's callback-style SFTP methods. */
function call<T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
}

async function remoteStat(sftp: SFTPWrapper, p: string): Promise<Stats | undefined> {
  try {
    return await call<Stats>((cb) => sftp.lstat(p, cb));
  } catch {
    return undefined;
  }
}

async function remoteMkdirP(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const current = '/' + parts.slice(0, i).join('/');
    const stat = await remoteStat(sftp, current);
    if (stat?.isDirectory()) continue;
    if (stat) throw new Error(`Remote path "${current}" exists and is not a directory`);
    await call<void>((cb) => sftp.mkdir(current, (err) => cb(err, undefined)));
  }
}

function withSftp<T>(connectionName: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return connectionManager.withClient(connectionName, async (client) => {
    const sftp = await call<SFTPWrapper>((cb) => client.sftp(cb));
    try {
      return await fn(sftp);
    } finally {
      sftp.end();
    }
  });
}

interface Policy {
  remoteRoots?: string[];
  localRoots?: string[];
  protectedLocal: string[];
}

function policyFor(connectionName: string): Policy {
  const config = connectionManager.getConfig(connectionName);
  if (!config) throw new Error(`Connection "${connectionName}" not found`);
  if (config.allowedCommands?.length && !config.remoteRoots?.length) {
    throw new Error(
      `SFTP is disabled on "${connectionName}": connections with allowedCommands must also define remoteRoots to use file transfers`
    );
  }
  return {
    remoteRoots: config.remoteRoots,
    localRoots: config.localRoots?.map(resolveLocal),
    protectedLocal: connectionManager.protectedLocalPaths(),
  };
}

function checkLocal(policy: Policy, localPath: string): string {
  const resolved = resolveLocal(localPath);
  const error = checkRoots(path, resolved, policy.localRoots, 'localRoots') ?? checkLocalProtected(resolved, policy.protectedLocal);
  if (error) throw new Error(error);
  return resolved;
}

async function resolveRemoteChecked(sftp: SFTPWrapper, policy: Policy, remotePath: string): Promise<string> {
  const realpath = (p: string) => call<string>((cb) => sftp.realpath(p, cb));
  const resolved = await resolveRemote(realpath, remotePath);
  const roots = policy.remoteRoots && (await Promise.all(policy.remoteRoots.map((r) => resolveRemote(realpath, r))));
  const error = checkRoots(path.posix, resolved, roots, 'remoteRoots');
  if (error) throw new Error(error);
  return resolved;
}

/** Lists files under a local directory (relative posix paths), skipping symlinks so they can't point outside the allowed roots. */
function walkLocal(root: string): { files: string[]; dirs: string[]; skipped: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const skipped: string[] = [];
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    const stat = fs.lstatSync(path.join(root, rel));
    const posixRel = rel.split(path.sep).join('/');
    if (stat.isSymbolicLink()) skipped.push(posixRel);
    else if (stat.isDirectory()) dirs.push(posixRel);
    else if (stat.isFile()) files.push(posixRel);
  }
  return { files, dirs, skipped };
}

async function walkRemote(sftp: SFTPWrapper, root: string, prefix = ''): Promise<{ files: string[]; dirs: string[]; skipped: string[] }> {
  const out = { files: [] as string[], dirs: [] as string[], skipped: [] as string[] };
  const entries = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(path.posix.join(root, prefix), cb));
  for (const { filename, attrs } of entries) {
    const rel = prefix ? `${prefix}/${filename}` : filename;
    if (attrs.isDirectory()) {
      out.dirs.push(rel);
      const sub = await walkRemote(sftp, root, rel);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
      out.skipped.push(...sub.skipped);
    } else if (attrs.isFile()) {
      out.files.push(rel);
    } else {
      out.skipped.push(rel);
    }
    if (out.files.length > MAX_TRANSFER_FILES) break;
  }
  return out;
}

function assertFileCount(count: number): void {
  if (count > MAX_TRANSFER_FILES) {
    throw new Error(`Transfer exceeds the limit of ${MAX_TRANSFER_FILES} files (SFTP_MAX_FILES)`);
  }
}

async function audited(
  event: 'upload' | 'download',
  connectionName: string,
  localPath: string,
  remotePath: string,
  run: () => Promise<TransferResult>
): Promise<TransferResult> {
  try {
    const result = await run();
    auditLog.recordTransfer({
      event,
      connection_name: connectionName,
      local_path: result.local_path,
      remote_path: result.remote_path,
      files: result.files,
      bytes: result.bytes,
      duration_ms: result.duration_ms,
    });
    return result;
  } catch (err) {
    auditLog.recordTransfer({ event, connection_name: connectionName, local_path: localPath, remote_path: remotePath, error: (err as Error).message });
    throw err;
  }
}

export function uploadFile(connectionName: string, localPath: string, remotePath: string, opts: TransferOptions = {}): Promise<TransferResult> {
  return audited('upload', connectionName, localPath, remotePath, () => {
    const policy = policyFor(connectionName);
    const local = checkLocal(policy, localPath);
    const localStat = fs.statSync(local);
    if (localStat.isDirectory() && !opts.recursive) throw new Error(`"${local}" is a directory — pass recursive=true to upload it`);

    const started = Date.now();
    return withSftp(connectionName, async (sftp) => {
      const remote = await resolveRemoteChecked(sftp, policy, remotePath);
      if (!opts.overwrite && (await remoteStat(sftp, remote))) {
        throw new Error(`Remote path "${remote}" already exists — pass overwrite=true to replace it`);
      }

      const plan = localStat.isDirectory() ? walkLocal(local) : { files: [''], dirs: [], skipped: [] };
      assertFileCount(plan.files.length);
      const target = (rel: string) => (rel ? `${remote}/${rel}` : remote);
      for (const rel of plan.files) {
        const error = checkRemoteWrite(target(rel));
        if (error) throw new Error(error);
      }

      await remoteMkdirP(sftp, localStat.isDirectory() ? remote : path.posix.dirname(remote));
      for (const rel of plan.dirs) await remoteMkdirP(sftp, target(rel));

      let bytes = 0;
      for (const rel of plan.files) {
        const src = rel ? path.join(local, ...rel.split('/')) : local;
        await call<void>((cb) => sftp.fastPut(src, target(rel), (err) => cb(err, undefined)));
        bytes += fs.statSync(src).size;
      }

      return { local_path: local, remote_path: remote, files: plan.files.length, bytes, skipped: plan.skipped, duration_ms: Date.now() - started };
    });
  });
}

export function downloadFile(connectionName: string, remotePath: string, localPath: string, opts: TransferOptions = {}): Promise<TransferResult> {
  return audited('download', connectionName, localPath, remotePath, () => {
    const policy = policyFor(connectionName);
    const local = checkLocal(policy, localPath);
    if (!opts.overwrite && fs.existsSync(local)) throw new Error(`Local path "${local}" already exists — pass overwrite=true to replace it`);

    const started = Date.now();
    return withSftp(connectionName, async (sftp) => {
      const remote = await resolveRemoteChecked(sftp, policy, remotePath);
      const remoteStatResult = await remoteStat(sftp, remote);
      if (!remoteStatResult) throw new Error(`Remote path "${remote}" does not exist`);
      const isDir = remoteStatResult.isDirectory();
      if (isDir && !opts.recursive) throw new Error(`"${remote}" is a directory — pass recursive=true to download it`);
      if (!isDir && !remoteStatResult.isFile()) throw new Error(`"${remote}" is not a regular file or directory`);

      const plan = isDir ? await walkRemote(sftp, remote) : { files: [''], dirs: [], skipped: [] };
      assertFileCount(plan.files.length);
      const target = (rel: string) => (rel ? path.join(local, ...rel.split('/')) : local);

      fs.mkdirSync(isDir ? local : path.dirname(local), { recursive: true });
      for (const rel of plan.dirs) fs.mkdirSync(target(rel), { recursive: true });

      let bytes = 0;
      for (const rel of plan.files) {
        await call<void>((cb) => sftp.fastGet(rel ? `${remote}/${rel}` : remote, target(rel), (err) => cb(err, undefined)));
        bytes += fs.statSync(target(rel)).size;
      }

      return { local_path: local, remote_path: remote, files: plan.files.length, bytes, skipped: plan.skipped, duration_ms: Date.now() - started };
    });
  });
}

function entryType(attrs: Stats): RemoteEntry['type'] {
  if (attrs.isDirectory()) return 'directory';
  if (attrs.isFile()) return 'file';
  if (attrs.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function listRemoteDir(connectionName: string, remotePath: string): Promise<{ path: string; entries: RemoteEntry[] }> {
  const policy = policyFor(connectionName);
  return withSftp(connectionName, async (sftp) => {
    const remote = await resolveRemoteChecked(sftp, policy, remotePath);
    const list = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(remote, cb));
    const entries = list
      .map(({ filename, attrs }) => ({
        name: filename,
        type: entryType(attrs),
        size: attrs.size,
        mode: (attrs.mode & 0o7777).toString(8).padStart(4, '0'),
        modified: new Date(attrs.mtime * 1000).toISOString(),
      }))
      .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return { path: remote, entries };
  });
}
