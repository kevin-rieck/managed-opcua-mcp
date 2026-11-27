import type { Mutation } from '../types/result.js';

export type AuditHealth = { healthy: true } | { healthy: false; reason: string };

interface AuditBase {
  id: string;
  attemptId: string;
  timestamp: string;
  configHash: string;
  nodeId?: string;
  dataType?: string;
  requestedValue?: boolean | number | string;
  reason?: string;
}

export type AuditEvent =
  | { event: 'write.preflight'; mutation: Extract<Mutation, { outcome: 'not_attempted' }> }
  | { event: 'write.intent'; mutation: { outcome: 'pending' } }
  | { event: 'write.completion'; mutation: Exclude<Mutation, { outcome: 'not_attempted' }> };
export type AuditRecord = AuditBase & AuditEvent;

export interface AuditAppendResult {
  id: string;
}

export interface AuditSink {
  health(): Promise<AuditHealth>;
  append(record: AuditRecord): Promise<AuditAppendResult>;
}
