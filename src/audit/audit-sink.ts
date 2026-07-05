export type AuditHealth =
  | { healthy: true }
  | { healthy: false; reason: string };

export interface AuditRecord {
  id: string;
  timestamp: string;
  event: string;
  controlName?: string;
  nodeId?: string;
  requestedValue?: unknown;
  rawRequestedValue?: unknown;
  result?: string;
  riskLevel?: string;
  callerIdentity?: string;
  configHash: string;
  opcuaStatus?: string;
  reason?: string;
  errorMessage?: string;
}

export interface AuditAppendResult {
  id: string;
}

export interface AuditSink {
  health(): Promise<AuditHealth>;
  append(record: AuditRecord): Promise<AuditAppendResult>;
}
