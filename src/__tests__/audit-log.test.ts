import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProcessRecord } from '../types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-test-'));
const logPath = path.join(tmpDir, 'audit.jsonl');
process.env.AUDIT_LOG_PATH = logPath;
process.env.AUDIT_LOG_DISABLED = 'false';

const { auditLog } = await import('../services/audit-log.js');

function makeRecord(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'proc_test',
    connection_name: 'test-server',
    command: 'ls -la',
    status: 'running',
    started_at: new Date().toISOString(),
    stdout: '',
    stderr: '',
    timeout_seconds: 30,
    ...overrides,
  };
}

describe('auditLog', () => {
  afterEach(() => {
    if (fs.existsSync(logPath)) fs.rmSync(logPath);
  });

  it('appends one JSON line per recorded event', () => {
    auditLog.record('created', makeRecord());
    auditLog.record('completed', makeRecord({ status: 'completed', exit_code: 0 }));

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.event).toBe('created');
    expect(first.process_id).toBe('proc_test');
    expect(first.connection_name).toBe('test-server');
  });

  it('redacts secrets from logged commands', () => {
    auditLog.record('created', makeRecord({ command: 'mysql -u root -pS3cr3t -e "select 1"' }));
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.command).not.toContain('S3cr3t');
    expect(entry.command).toContain('-p***');
  });

  it('writes transfer events', () => {
    auditLog.recordTransfer({ event: 'upload', connection_name: 'srv', local_path: '/a', remote_path: '/b', files: 1, bytes: 10 });
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry).toMatchObject({ event: 'upload', connection_name: 'srv', bytes: 10 });
    expect(entry.timestamp).toBeTruthy();
  });

  it.each([
    ['mysql -u root -pS3cr3t db', 'S3cr3t'],
    ['sshpass -p hunter2 ssh x', 'hunter2'],
    ['curl --password=hunter2 x', 'hunter2'],
    ['psql --token abc123', 'abc123'],
    ['DB_PASSWORD=hunter2 npm start', 'hunter2'],
    ['git clone https://user:ghp_tok@github.com/x', 'ghp_tok'],
  ])('redactSecrets hides the secret in %j', async (command, secret) => {
    const { redactSecrets } = await import('../services/audit-log.js');
    expect(redactSecrets(command)).not.toContain(secret);
  });

  it('redactSecrets leaves ordinary commands alone', async () => {
    const { redactSecrets } = await import('../services/audit-log.js');
    expect(redactSecrets('mkdir -p /opt/app && ssh -p 22 host')).toBe('mkdir -p /opt/app && ssh -p 22 host');
  });

  it('does not write anything when disabled', async () => {
    process.env.AUDIT_LOG_DISABLED = 'true';
    // Re-import with a fresh module instance to pick up the disabled flag.
    const disabledLogPath = path.join(tmpDir, 'disabled-audit.jsonl');
    process.env.AUDIT_LOG_PATH = disabledLogPath;
    const mod = await import(`../services/audit-log.js?disabled-test`);
    mod.auditLog.record('created', makeRecord());
    expect(fs.existsSync(disabledLogPath)).toBe(false);

    process.env.AUDIT_LOG_DISABLED = 'false';
    process.env.AUDIT_LOG_PATH = logPath;
  });
});
