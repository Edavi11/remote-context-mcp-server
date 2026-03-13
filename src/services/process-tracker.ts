import { ProcessRecord, ProcessStatus } from '../types.js';

function generateProcessId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `proc_${timestamp}_${random}`;
}

class ProcessTracker {
  private records = new Map<string, ProcessRecord>();

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
    return record;
  }

  appendStdout(id: string, data: string): void {
    const record = this.records.get(id);
    if (record && record.status === 'running') {
      record.stdout += data;
    }
  }

  appendStderr(id: string, data: string): void {
    const record = this.records.get(id);
    if (record && record.status === 'running') {
      record.stderr += data;
    }
  }

  complete(id: string, exit_code: number): ProcessRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(record.started_at).getTime();

    record.status = exit_code === 0 ? 'completed' : 'failed';
    record.finished_at = finished_at;
    record.duration_ms = duration_ms;
    record.exit_code = exit_code;

    return record;
  }

  timeout(id: string): ProcessRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;

    const finished_at = new Date().toISOString();
    const duration_ms = new Date(finished_at).getTime() - new Date(record.started_at).getTime();

    record.status = 'timeout';
    record.finished_at = finished_at;
    record.duration_ms = duration_ms;

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
