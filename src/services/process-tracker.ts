import { ProcessRecord, ProcessStatus } from '../types.js';
import { auditLog } from './audit-log.js';

function generateProcessId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `proc_${timestamp}_${random}`;
}

const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES) || 1_000_000;
const MAX_RECORDS = Number(process.env.MAX_PROCESS_RECORDS) || 500;
const TRUNCATION_NOTICE = '\n[...output truncated, limit reached...]';

class ProcessTracker {
  private records = new Map<string, ProcessRecord>();
  private truncated = new Set<string>();

  private appendBounded(record: ProcessRecord, field: 'stdout' | 'stderr', data: string): void {
    if (this.truncated.has(record.id)) return;

    const remaining = MAX_OUTPUT_BYTES - record[field].length;
    if (remaining <= 0) {
      record[field] += TRUNCATION_NOTICE;
      this.truncated.add(record.id);
      return;
    }

    record[field] += data.length > remaining ? data.slice(0, remaining) : data;
    if (data.length > remaining) {
      record[field] += TRUNCATION_NOTICE;
      this.truncated.add(record.id);
    }
  }

  private evictIfNeeded(): void {
    if (this.records.size <= MAX_RECORDS) return;

    for (const [id, record] of this.records) {
      if (this.records.size <= MAX_RECORDS) break;
      if (record.status === 'running') continue;
      this.records.delete(id);
      this.truncated.delete(id);
    }
  }

  create(params: {
    connection_name: string;
    command: string;
    working_directory?: string;
    timeout_seconds: number;
  }): ProcessRecord {
    const id = generateProcessId();
    const record: ProcessRecord = {
      id,
      connection_name: params.connection_name,
      command: params.command,
      working_directory: params.working_directory,
      status: 'running',
      started_at: new Date().toISOString(),
      stdout: '',
      stderr: '',
      timeout_seconds: params.timeout_seconds,
    };
    this.records.set(id, record);
    this.evictIfNeeded();
    auditLog.record('created', record);
    return record;
  }

  createBlocked(params: {
    connection_name: string;
    command: string;
    working_directory?: string;
    timeout_seconds: number;
    blocked_reason: string;
  }): ProcessRecord {
    const id = generateProcessId();
    const now = new Date().toISOString();
    const record: ProcessRecord = {
      id,
      connection_name: params.connection_name,
      command: params.command,
      working_directory: params.working_directory,
      status: 'blocked',
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      stdout: '',
      stderr: '',
      timeout_seconds: params.timeout_seconds,
      blocked_reason: params.blocked_reason,
    };
    this.records.set(id, record);
    this.evictIfNeeded();
    auditLog.record('blocked', record);
    return record;
  }

  appendStdout(id: string, data: string): void {
    const record = this.records.get(id);
    if (record && record.status === 'running') {
      this.appendBounded(record, 'stdout', data);
    }
  }

  appendStderr(id: string, data: string): void {
    const record = this.records.get(id);
    if (record && record.status === 'running') {
      this.appendBounded(record, 'stderr', data);
    }
  }

  complete(id: string, exit_code: number): ProcessRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    // A kill() already finalized this record — don't let a late exec() resolution overwrite it.
    if (record.status === 'killed') return record;

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(record.started_at).getTime();

    record.status = exit_code === 0 ? 'completed' : 'failed';
    record.finished_at = finished_at;
    record.duration_ms = duration_ms;
    record.exit_code = exit_code;

    auditLog.record(record.status, record);
    return record;
  }

  timeout(id: string): ProcessRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.status === 'killed') return record;

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(record.started_at).getTime();

    record.status = 'timeout';
    record.finished_at = finished_at;
    record.duration_ms = duration_ms;

    auditLog.record('timeout', record);
    return record;
  }

  kill(id: string): ProcessRecord | undefined {
    const record = this.records.get(id);
    if (!record || record.status !== 'running') return undefined;

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(record.started_at).getTime();

    record.status = 'killed';
    record.finished_at = finished_at;
    record.duration_ms = duration_ms;

    auditLog.record('killed', record);
    return record;
  }

  get(id: string): ProcessRecord | undefined {
    return this.records.get(id);
  }

  list(filters?: { connection_name?: string; status?: ProcessStatus }): Omit<ProcessRecord, 'stdout' | 'stderr'>[] {
    const all = Array.from(this.records.values());
    const filtered = all.filter((r) => {
      if (filters?.connection_name && r.connection_name !== filters.connection_name) return false;
      if (filters?.status && r.status !== filters.status) return false;
      return true;
    });

    return filtered.map(({ stdout: _stdout, stderr: _stderr, ...meta }) => meta);
  }
}

export const processTracker = new ProcessTracker();
