import { randomUUID } from 'node:crypto';
import type { AuditSink, AuditRecord, AuditEvent } from '../audit/audit-sink.js';
import type { AppConfig } from '../config/schema.js';
import type { OpcUaGateway } from '../opcua/gateway.js';
import {
  NativeEncodingError,
  parseNativeNodeId,
  validateNativeScalar,
  validUnicode,
} from '../opcua/native-encoding.js';
import { mapStatusCode, statusSeverity, type StatusCode } from '../opcua/status-code.js';

import type { WriteErrorCode, WriteError, Mutation, WriteResult } from '../types/result.js';

const messages: Record<WriteErrorCode, string> = {
  invalid_node_id: 'Invalid local NodeId.',
  node_id_too_long: 'NodeId exceeds the maximum length.',
  unsupported_data_type: 'Unsupported data type.',
  invalid_value: 'Invalid value for data type.',
  value_out_of_range: 'Value is out of range.',
  value_too_long: 'Value exceeds the maximum length.',
  invalid_reason: 'Invalid reason.',
  disconnected: 'OPC UA is disconnected.',
  audit_unavailable: 'Audit logging is unavailable.',
  opcua_write_rejected: 'OPC UA Server rejected the write.',
  opcua_service_error: 'OPC UA write service failed.',
  write_outcome_unknown: 'OPC UA write outcome is unknown.',
};
function writeError(code: WriteErrorCode, statusCode?: StatusCode): WriteError {
  return { code, message: messages[code], ...(statusCode ? { statusCode } : {}) };
}

export async function writeNode(
  dependencies: {
    config: AppConfig;
    configHash: string;
    gateway: OpcUaGateway;
    auditSink: AuditSink;
  },
  args: { nodeId: string; dataType: string; value: unknown; reason?: string },
): Promise<WriteResult> {
  const attemptId = randomUUID();
  const recordIds: string[] = [];
  let node: ReturnType<typeof parseNativeNodeId> | undefined;
  let scalar: ReturnType<typeof validateNativeScalar> | undefined;
  let nodeError: WriteErrorCode | undefined;
  let valueError: WriteErrorCode | undefined;
  try {
    node = parseNativeNodeId(args.nodeId);
  } catch (error) {
    if (!(error instanceof NativeEncodingError)) throw error;
    nodeError = error.code;
  }
  try {
    scalar = validateNativeScalar(args.dataType, args.value);
  } catch (error) {
    if (!(error instanceof NativeEncodingError)) throw error;
    valueError = error.code;
  }
  const validReason =
    args.reason === undefined ||
    (args.reason.length > 0 &&
      args.reason.length <= dependencies.config.audit.maxReasonLength * 2 &&
      validUnicode(args.reason) &&
      Array.from(args.reason).length <= dependencies.config.audit.maxReasonLength);
  const supportedType = valueError !== 'unsupported_data_type';
  const fields = {
    ...(node ? { nodeId: node.text } : {}),
    ...(supportedType ? { dataType: args.dataType } : {}),
    ...(scalar ? { requestedValue: scalar.value } : {}),
    ...(validReason && args.reason !== undefined ? { reason: args.reason } : {}),
  };
  async function append(entry: AuditEvent): Promise<boolean> {
    let id = randomUUID();
    while (id === attemptId || recordIds.includes(id)) id = randomUUID();
    const record: AuditRecord = {
      id,
      attemptId,
      timestamp: new Date().toISOString(),
      configHash: dependencies.configHash,
      ...fields,
      ...entry,
    };
    try {
      await dependencies.auditSink.append(record);
      recordIds.push(id);
      return true;
    } catch {
      return false;
    }
  }
  function result(mutation: Mutation, recorded: boolean): WriteResult {
    return {
      ok: mutation.outcome === 'accepted' && recorded,
      attemptId,
      mutation,
      audit: recorded
        ? { outcome: 'recorded', recordIds }
        : { outcome: 'failed', recordIds, error: writeError('audit_unavailable') },
    };
  }
  async function preflight(code: WriteErrorCode): Promise<WriteResult> {
    const mutation: Mutation = { outcome: 'not_attempted', error: writeError(code) };
    return result(mutation, await append({ event: 'write.preflight', mutation }));
  }
  const validationError = nodeError ?? valueError ?? (!validReason ? 'invalid_reason' : undefined);
  if (validationError) return preflight(validationError);
  if (!node || !scalar) throw new Error('Validated write input is unavailable.');
  let healthy = false;
  try {
    healthy = (await dependencies.auditSink.health()).healthy;
  } catch {
    healthy = false;
  }
  if (!healthy) return preflight('audit_unavailable');
  let connected = false;
  try {
    connected = (await dependencies.gateway.status()).state === 'connected';
  } catch {
    connected = false;
  }
  if (!connected) return preflight('disconnected');
  if (!(await append({ event: 'write.intent', mutation: { outcome: 'pending' } })))
    return result({ outcome: 'not_attempted', error: writeError('audit_unavailable') }, false);
  let mutation: Mutation;
  try {
    const write = await dependencies.gateway.writeNative(node, scalar.dataType, scalar.value);
    const statusCode = mapStatusCode(write.statusCode);
    if (write.kind === 'service_error')
      mutation = { outcome: 'unknown', error: writeError('opcua_service_error', statusCode) };
    else if (!statusCode)
      mutation = { outcome: 'unknown', error: writeError('write_outcome_unknown') };
    else {
      const status = statusCode;
      const severity = statusSeverity(status);
      if (severity === 'good') mutation = { outcome: 'accepted', statusCode: status };
      else if (severity === 'bad')
        mutation = {
          outcome: 'rejected',
          statusCode: status,
          error: writeError('opcua_write_rejected', status),
        };
      else mutation = { outcome: 'unknown', error: writeError('write_outcome_unknown', status) };
    }
  } catch {
    mutation = { outcome: 'unknown', error: writeError('write_outcome_unknown') };
  }
  return result(mutation, await append({ event: 'write.completion', mutation }));
}
