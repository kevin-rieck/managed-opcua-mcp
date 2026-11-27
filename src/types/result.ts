import type { StatusCode } from '../opcua/status-code.js';

export type WriteErrorCode =
  | 'invalid_node_id'
  | 'node_id_too_long'
  | 'unsupported_data_type'
  | 'invalid_value'
  | 'value_out_of_range'
  | 'value_too_long'
  | 'invalid_reason'
  | 'disconnected'
  | 'audit_unavailable'
  | 'opcua_write_rejected'
  | 'opcua_service_error'
  | 'write_outcome_unknown';
export interface WriteError {
  code: WriteErrorCode;
  message: string;
  statusCode?: StatusCode;
}
export type Mutation =
  | { outcome: 'not_attempted'; error: WriteError }
  | { outcome: 'accepted'; statusCode: StatusCode }
  | { outcome: 'rejected'; statusCode: StatusCode; error: WriteError }
  | { outcome: 'unknown'; error: WriteError };
export type WriteAudit =
  | { outcome: 'recorded'; recordIds: string[] }
  | { outcome: 'failed'; recordIds: string[]; error: WriteError };
export interface WriteResult {
  ok: boolean;
  attemptId: string;
  mutation: Mutation;
  audit: WriteAudit;
}
