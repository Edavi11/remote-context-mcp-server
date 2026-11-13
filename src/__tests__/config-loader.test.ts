import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, expandHome } from '../services/config-loader.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-test-'));
const missingDefault = path.join(tmpDir, 'no-default.json');

function writeConfig(name: string, content: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

const conn = (overrides: Record<string, unknown> = {}) => ({ name: 'srv', host: 'h', username: 'u', password: 'p', ...overrides });

describe('loadConfig', () => {
  it('loads connections from REMOTE_CONTEXT_CONFIG', () => {
    const file = writeConfig('ok.json', [conn(), conn({ name: 'srv2' })]);
    const result = loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault);
    expect(result.error).toBeUndefined();
    expect(result.source).toBe(file);
    expect(result.connections.map((c) => c.name)).toEqual(['srv', 'srv2']);
    expect(result.connections[0].port).toBe(22);
  });

  it('falls back to the default config file when no env var is set', () => {
    const file = writeConfig('default.json', [conn()]);
    const result = loadConfig({}, file);
    expect(result.source).toBe(file);
    expect(result.connections).toHaveLength(1);
  });

  it('prefers the config file over legacy SSH_CONNECTIONS', () => {
    const file = writeConfig('pref.json', [conn({ name: 'from-file' })]);
    const result = loadConfig({ REMOTE_CONTEXT_CONFIG: file, SSH_CONNECTIONS: JSON.stringify([conn({ name: 'from-env' })]) }, missingDefault);
    expect(result.connections[0].name).toBe('from-file');
  });

  it('falls back to legacy SSH_CONNECTIONS', () => {
    const result = loadConfig({ SSH_CONNECTIONS: JSON.stringify([conn({ name: 'legacy' })]) }, missingDefault);
    expect(result.source).toBe('SSH_CONNECTIONS');
    expect(result.connections[0].name).toBe('legacy');
  });

  it('reports when nothing is configured', () => {
    const result = loadConfig({}, missingDefault);
    expect(result.connections).toEqual([]);
    expect(result.error).toMatch(/No connections configured/);
  });

  it('reports a missing config file', () => {
    const result = loadConfig({ REMOTE_CONTEXT_CONFIG: path.join(tmpDir, 'nope.json') }, missingDefault);
    expect(result.error).toMatch(/Cannot read config file/);
  });

  it('reports invalid JSON', () => {
    const file = writeConfig('bad.json', '{ not json');
    expect(loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault).error).toMatch(/not valid JSON/);
  });

  it('reports schema errors with the offending field', () => {
    const file = writeConfig('schema.json', [conn({ host: '' })]);
    const result = loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault);
    expect(result.connections).toEqual([]);
    expect(result.error).toMatch(/host/);
  });

  it('rejects duplicate connection names', () => {
    const file = writeConfig('dup.json', [conn(), conn()]);
    expect(loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault).error).toMatch(/Duplicate connection name "srv"/);
  });

  it('rejects connections without any credential', () => {
    const file = writeConfig('nocred.json', [{ name: 'srv', host: 'h', username: 'u' }]);
    expect(loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault).error).toMatch(/password, passwordFile, or privateKeyPath/);
  });

  it('rejects invalid allowedCommands regexes', () => {
    const file = writeConfig('regex.json', [conn({ allowedCommands: ['ls ('] })]);
    expect(loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault).error).toMatch(/valid regular expressions/);
  });

  it('expands ~ in key/secret paths and localRoots', () => {
    const file = writeConfig('tilde.json', [conn({ privateKeyPath: '~/.ssh/id_ed25519', passwordFile: '~/pw', localRoots: ['~/work'] })]);
    const [c] = loadConfig({ REMOTE_CONTEXT_CONFIG: file }, missingDefault).connections;
    expect(c.privateKeyPath).toBe(path.join(os.homedir(), '.ssh', 'id_ed25519'));
    expect(c.passwordFile).toBe(path.join(os.homedir(), 'pw'));
    expect(c.localRoots).toEqual([path.join(os.homedir(), 'work')]);
  });
});

describe('expandHome', () => {
  it('only expands a leading ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('/opt/~x')).toBe('/opt/~x');
    expect(expandHome('~user/x')).toBe('~user/x');
  });
});
