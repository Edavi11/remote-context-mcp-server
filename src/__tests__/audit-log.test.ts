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
