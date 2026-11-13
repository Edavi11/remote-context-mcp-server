import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProcessRecord } from '../types.js';

export type AuditEvent = 'created' | 'completed' | 'failed' | 'timeout' | 'blocked' | 'killed';

export interface TransferAuditEntry {
  event: 'upload' | 'download';
  connection_name: string;
  local_path: string;
  remote_path: string;
  files?: number;
  bytes?: number;
  duration_ms?: number;
  error?: string;
}

// ponytail: best-effort regexes for the common shapes, not a guarantee — a secret
// passed in an unusual form still lands in the log. Add patterns as they show up.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?\s-p)(?!\s)\S+/g, '$1***'],
  [/(\bsshpass\s+-p\s*)\S+/g, '$1***'],
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key)(?:=|\s+))\S+/gi, '$1***'],
  [/(\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY)[A-Za-z0-9_]*=)\S+/gi, '$1***'],
  [/(\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@'],
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function defaultLogPath(): string {
  return path.join(os.homedir(), '.remote-context-mcp', 'audit.jsonl');
}

class AuditLog {
  readonly logPath = process.env.AUDIT_LOG_PATH || defaultLogPath();
  private disabled = process.env.AUDIT_LOG_DISABLED === 'true';

  private write(entry: object): void {
    if (this.disabled) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf-8');
    } catch (err) {
      console.error(`[remote-context] Failed to write audit log entry: ${(err as Error).message}`);
    }
  }

  record(event: AuditEvent, record: ProcessRecord): void {
    this.write({
      event,
      process_id: record.id,
      connection_name: record.connection_name,
      command: redactSecrets(record.command),
      working_directory: record.working_directory,
      status: record.status,
      exit_code: record.exit_code,
      signal: record.signal,
      duration_ms: record.duration_ms,
      blocked_reason: record.blocked_reason,
    });
  }

  recordTransfer(entry: TransferAuditEntry): void {
    this.write(entry);
  }
}

export const auditLog = new AuditLog();
