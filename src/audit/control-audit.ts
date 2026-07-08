import { randomUUID } from 'node:crypto';
import type { AuditAppendResult, AuditRecord, AuditSink } from './audit-sink.js';

export type AuditPreflightResult =
  | { ok: true }
  | { ok: false; code: 'audit_unavailable'; message: string };

export interface AppendControlAuditRecordOptions {
  maxReasonLength: number;
  record: Omit<AuditRecord, 'id' | 'timestamp'> & Partial<Pick<AuditRecord, 'id' | 'timestamp'>>;
}

export async function requireHealthyAudit(auditSink: AuditSink): Promise<AuditPreflightResult> {
  try {
    const health = await auditSink.health();
    if (health.healthy) return { ok: true };
    return auditUnavailable(health.reason);
  } catch (error) {
    return auditUnavailable(error instanceof Error ? error.message : 'Audit health unavailable.');
  }
}

function auditUnavailable(reason: string): AuditPreflightResult {
  return {
    ok: false,
    code: 'audit_unavailable',
    message: `Audit logging is unavailable: ${sanitizeMessage(reason)}`,
  };
}

function sanitizeMessage(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? 'unknown error';
}

export async function appendControlAuditRecord(
  auditSink: AuditSink,
  options: AppendControlAuditRecordOptions,
): Promise<AuditAppendResult> {
  const record: AuditRecord = {
    id: options.record.id ?? randomUUID(),
    timestamp: options.record.timestamp ?? new Date().toISOString(),
    ...options.record,
    ...(options.record.reason !== undefined
      ? { reason: options.record.reason.slice(0, options.maxReasonLength) }
      : {}),
  };
  return auditSink.append(record);
}
