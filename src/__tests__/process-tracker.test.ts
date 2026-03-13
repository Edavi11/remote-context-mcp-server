import { describe, it, expect, beforeEach } from 'vitest';
import { processTracker } from '../services/process-tracker.js';

// Reset tracker between tests by accessing internal state via the module
// Since processTracker is a singleton, we need to work with it as-is
// and just verify behavior across the test file

describe('processTracker', () => {
  const baseParams = {
    connection_name: 'test-server',
    command: 'ls -la',
    timeout_seconds: 30,
  };

  describe('create', () => {
    it('creates a record with running status', () => {
      const record = processTracker.create(baseParams);
      expect(record.id).toMatch(/^proc_/);
      expect(record.status).toBe('running');
      expect(record.connection_name).toBe('test-server');
      expect(record.command).toBe('ls -la');
      expect(record.stdout).toBe('');
      expect(record.stderr).toBe('');
      expect(record.started_at).toBeTruthy();
      expect(record.finished_at).toBeUndefined();
    });

    it('generates unique IDs for each record', () => {
      const r1 = processTracker.create(baseParams);
      const r2 = processTracker.create(baseParams);
      expect(r1.id).not.toBe(r2.id);
    });

    it('stores working_directory if provided', () => {
      const record = processTracker.create({ ...baseParams, working_directory: '/var/www' });
      expect(record.working_directory).toBe('/var/www');
    });
  });

  describe('createBlocked', () => {
    it('creates a blocked record immediately finished', () => {
      const record = processTracker.createBlocked({
        ...baseParams,
        blocked_reason: 'Fork bomb detected',
      });
      expect(record.status).toBe('blocked');
      expect(record.blocked_reason).toBe('Fork bomb detected');
      expect(record.finished_at).toBeTruthy();
      expect(record.duration_ms).toBe(0);
    });
  });

  describe('appendStdout / appendStderr', () => {
    it('accumulates stdout', () => {
      const record = processTracker.create(baseParams);
      processTracker.appendStdout(record.id, 'hello ');
      processTracker.appendStdout(record.id, 'world');
      const updated = processTracker.get(record.id);
      expect(updated?.stdout).toBe('hello world');
    });

    it('accumulates stderr', () => {
      const record = processTracker.create(baseParams);
      processTracker.appendStderr(record.id, 'error: ');
      processTracker.appendStderr(record.id, 'not found');
      const updated = processTracker.get(record.id);
      expect(updated?.stderr).toBe('error: not found');
    });

    it('does not append to non-running processes', () => {
      const record = processTracker.create(baseParams);
      processTracker.complete(record.id, 0);
      processTracker.appendStdout(record.id, 'late data');
      const updated = processTracker.get(record.id);
      expect(updated?.stdout).toBe('');
    });
  });

  describe('complete', () => {
    it('marks process as completed on exit code 0', () => {
      const record = processTracker.create(baseParams);
      const completed = processTracker.complete(record.id, 0);
      expect(completed?.status).toBe('completed');
      expect(completed?.exit_code).toBe(0);
      expect(completed?.finished_at).toBeTruthy();
      expect(completed?.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('marks process as failed on non-zero exit code', () => {
      const record = processTracker.create(baseParams);
      const completed = processTracker.complete(record.id, 1);
      expect(completed?.status).toBe('failed');
      expect(completed?.exit_code).toBe(1);
    });

    it('returns undefined for unknown process id', () => {
      expect(processTracker.complete('proc_nonexistent', 0)).toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('marks process as timeout', () => {
      const record = processTracker.create(baseParams);
      const timedOut = processTracker.timeout(record.id);
      expect(timedOut?.status).toBe('timeout');
      expect(timedOut?.finished_at).toBeTruthy();
      expect(timedOut?.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('get', () => {
    it('retrieves a record by id', () => {
      const record = processTracker.create(baseParams);
      const retrieved = processTracker.get(record.id);
      expect(retrieved?.id).toBe(record.id);
    });

    it('returns undefined for unknown id', () => {
      expect(processTracker.get('proc_does_not_exist_xyz')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns records without stdout/stderr', () => {
      const record = processTracker.create({ ...baseParams, connection_name: 'list-test-server' });
      processTracker.appendStdout(record.id, 'some output');
      const listed = processTracker.list({ connection_name: 'list-test-server' });
      const found = listed.find((r) => r.id === record.id);
      expect(found).toBeDefined();
      expect((found as Record<string, unknown>)['stdout']).toBeUndefined();
      expect((found as Record<string, unknown>)['stderr']).toBeUndefined();
    });

    it('filters by connection_name', () => {
      processTracker.create({ ...baseParams, connection_name: 'server-alpha' });
      processTracker.create({ ...baseParams, connection_name: 'server-beta' });
      const results = processTracker.list({ connection_name: 'server-alpha' });
      expect(results.every((r) => r.connection_name === 'server-alpha')).toBe(true);
    });

    it('filters by status', () => {
      const r = processTracker.create({ ...baseParams, connection_name: 'status-filter-test' });
      processTracker.complete(r.id, 0);
      const running = processTracker.list({ connection_name: 'status-filter-test', status: 'running' });
      const completed = processTracker.list({ connection_name: 'status-filter-test', status: 'completed' });
      expect(running.find((p) => p.id === r.id)).toBeUndefined();
      expect(completed.find((p) => p.id === r.id)).toBeDefined();
    });
  });
});
