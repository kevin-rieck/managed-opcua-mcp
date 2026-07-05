export type UnavailableReasonCode =
  | 'controls_disabled'
  | 'opcua_disconnected'
  | 'online_validation_pending'
  | 'online_validation_failed'
  | 'cooldown_active'
  | 'audit_unavailable'
  | 'control_not_found'
  | 'unsupported_data_type'
  | 'outside_read_scope'
  | 'value_out_of_range'
  | 'confirmation_required';

export interface Reason {
  code: UnavailableReasonCode;
  message: string;
  retryAfterMs?: number;
  opcuaStatus?: string;
}
