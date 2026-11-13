import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { SSHConnectionConfig } from '../types.js';
import { SSHConnectionsSchema } from '../schemas/connection.js';

export const DATA_DIR = path.join(os.homedir(), '.remote-context-mcp');
export const DEFAULT_CONFIG_PATH = path.join(DATA_DIR, 'connections.json');

export interface LoadedConfig {
  connections: SSHConnectionConfig[];
  /** Config file path, 'SSH_CONNECTIONS' (legacy env) or 'none'. */
  source: string;
  error?: string;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function expandPaths(c: SSHConnectionConfig): SSHConnectionConfig {
  const ex = (p?: string) => (p === undefined ? undefined : expandHome(p));
  return {
    ...c,
    privateKeyPath: ex(c.privateKeyPath),
    passwordFile: ex(c.passwordFile),
    passphraseFile: ex(c.passphraseFile),
    localRoots: c.localRoots?.map(expandHome),
  };
}

/**
 * Resolution order (first match wins):
 *   1. REMOTE_CONTEXT_CONFIG — path to a JSON config file
 *   2. ~/.remote-context-mcp/connections.json — default config file
 *   3. SSH_CONNECTIONS — inline JSON (legacy, deprecated)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, defaultPath = DEFAULT_CONFIG_PATH): LoadedConfig {
  const explicit = env.REMOTE_CONTEXT_CONFIG?.trim();
  let source: string;
  let raw: string | undefined;

  if (explicit) {
    source = path.resolve(expandHome(explicit));
  } else if (fs.existsSync(defaultPath)) {
    source = defaultPath;
  } else if (env.SSH_CONNECTIONS) {
    source = 'SSH_CONNECTIONS';
    raw = env.SSH_CONNECTIONS;
    console.error(
      `[remote-context] SSH_CONNECTIONS is deprecated. Move your connections to ${defaultPath} or set REMOTE_CONTEXT_CONFIG.`
    );
  } else {
    return {
      connections: [],
      source: 'none',
      error: `No connections configured. Create ${defaultPath} or set REMOTE_CONTEXT_CONFIG to a config file path.`,
    };
  }

  if (raw === undefined) {
    try {
      raw = fs.readFileSync(source, 'utf-8');
    } catch (err) {
      return { connections: [], source, error: `Cannot read config file "${source}": ${(err as Error).message}` };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { connections: [], source, error: `${source} is not valid JSON. Expected a JSON array of connection objects.` };
  }

  const result = SSHConnectionsSchema.safeParse(parsed);
  if (!result.success) {
    return { connections: [], source, error: `Invalid connections in ${source}:\n${z.prettifyError(result.error)}` };
  }

  return { connections: result.data.map(expandPaths), source };
}
