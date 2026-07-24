import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProcessRecord } from '../types.js';

export type AuditEvent = 'created' | 'completed' | 'failed' | 'timeout' | 'blocked' | 'killed';

function defaultLogPath(): string {
  return path.join(os.homedir(), '.remote-context-mcp', 'audit.jsonl');
}

class AuditLog {
  private logPath = process.env.AUDIT_LOG_PATH || defaultLogPath();
  private disabled = process.env.AUDIT_LOG_DISABLED === 'true';

  record(event: AuditEvent, record: ProcessRecord): void {
    if (this.disabled) return;

    const entry = {
      timestamp: new Date().toISOString(),
      event,
      process_id: record.id,
      connection_name: record.connection_name,
      command: record.command,
      working_directory: record.working_directory,
      status: record.status,
      exit_code: record.exit_code,
      duration_ms: record.duration_ms,
      blocked_reason: record.blocked_reason,
    };

    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      console.error(`[remote-context] Failed to write audit log entry: ${(err as Error).message}`);
    }
  }
}

export const auditLog = new AuditLog();
