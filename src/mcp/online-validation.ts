import type { AppConfig, ControlItem } from '../config/schema.js';
import type { NodeMetadataResult, OpcUaGateway, OpcUaStatus } from '../opcua/gateway.js';

export type OnlineValidationState = 'pending' | 'valid' | 'invalid';

const SCALAR_VALUE_RANK = -1;

export interface OnlineValidationReason extends Record<string, unknown> {
  code: string;
  message: string;
  nodeId?: string;
  label?: string;
  controlName?: string;
}

export interface OnlineValidationResult {
  state: OnlineValidationState;
  connectionGeneration: number;
  reasons: OnlineValidationReason[];
  controls: Record<string, OnlineValidationReason[]>;
  readRoots: OnlineValidationReason[];
}

export interface OnlineValidationCache {
  generation?: number;
  result?: OnlineValidationResult;
}

export async function getOnlineValidation(
  config: AppConfig,
  gateway: OpcUaGateway,
  cache: OnlineValidationCache,
): Promise<OnlineValidationResult> {
  let status: OpcUaStatus;
  try {
    status = await gateway.status();
  } catch (error) {
    return {
      state: 'pending',
      connectionGeneration: 0,
      reasons: [
        {
          code: 'online_validation_status_unavailable',
          message: sanitizeMessage(
            error instanceof Error ? error.message : 'OPC UA status unavailable.',
          ),
        },
      ],
      controls: {},
      readRoots: [],
    };
  }
  if (status.state !== 'connected') return pendingValidation(status);

  if (cache.generation === status.connectionGeneration && cache.result !== undefined) {
    return cache.result;
  }

  const result = await validateOnlineConfig(config, gateway, status);
  cache.generation = status.connectionGeneration;
  cache.result = result;
  return result;
}

export function validationReasonsForControl(
  validation: OnlineValidationResult,
  controlName: string,
): OnlineValidationReason[] {
  return validation.controls[controlName] ?? [];
}

async function validateOnlineConfig(
  config: AppConfig,
  gateway: OpcUaGateway,
  status: OpcUaStatus,
): Promise<OnlineValidationResult> {
  const readRoots: OnlineValidationReason[] = [];
  const controls: Record<string, OnlineValidationReason[]> = {};

  for (const root of config.read.roots) {
    const metadata = await safeNodeMetadata(gateway, root.nodeId);
    if (!metadata.ok) {
      readRoots.push({
        code: 'read_root_unavailable',
        message: metadata.message,
        nodeId: root.nodeId,
        ...(root.label !== undefined ? { label: root.label } : {}),
      });
      continue;
    }
    if (metadata.value.exists === false || metadata.value.browseable === false) {
      const nodeIdStatus = metadata.value.attributeStatuses?.nodeId;
      const unavailable = metadata.value.exists === false && isAccessFailure(nodeIdStatus);
      const missing = metadata.value.exists === false && !unavailable;
      readRoots.push({
        code: unavailable
          ? 'read_root_unavailable'
          : missing
            ? 'read_root_missing'
            : 'read_root_not_browseable',
        message: unavailable
          ? 'Read Entry Point Node could not be inspected.'
          : missing
            ? 'Read Entry Point Node does not exist.'
            : 'Read Entry Point is not browseable.',
        nodeId: root.nodeId,
        ...(root.label !== undefined ? { label: root.label } : {}),
        ...metadataEvidence(metadata.value),
      });
    }
  }

  for (const control of config.controls?.items ?? []) {
    const reasons = await validateControl(gateway, control);
    if (reasons.length > 0) controls[control.name] = reasons;
  }

  const reasons = [...readRoots, ...Object.values(controls).flat()];
  return {
    state: reasons.length === 0 ? 'valid' : 'invalid',
    connectionGeneration: status.connectionGeneration,
    reasons,
    controls,
    readRoots,
  };
}

async function validateControl(
  gateway: OpcUaGateway,
  control: ControlItem,
): Promise<OnlineValidationReason[]> {
  const metadata = await safeNodeMetadata(gateway, control.nodeId);
  if (!metadata.ok) {
    return [
      {
        code: 'control_target_unavailable',
        message: metadata.message,
        nodeId: control.nodeId,
        controlName: control.name,
      },
    ];
  }

  const reasons: OnlineValidationReason[] = [];
  if (metadata.value.exists === false) {
    const unavailable = isAccessFailure(metadata.value.attributeStatuses?.nodeId);
    reasons.push(
      reason(
        control,
        unavailable ? 'control_target_unavailable' : 'control_target_missing',
        unavailable
          ? 'Semantic Control target Node could not be inspected.'
          : 'Semantic Control target Node does not exist.',
      ),
    );
    return withMetadataEvidence(reasons, metadata.value);
  }
  if (metadata.value.readable === false) {
    reasons.push(
      reason(
        control,
        'control_target_not_readable',
        'Semantic Control target Node is not readable.',
      ),
    );
  }
  if (metadata.value.writable === false) {
    reasons.push(
      reason(
        control,
        'control_target_not_writable',
        'Semantic Control target Node is not writable.',
      ),
    );
  }
  if (
    metadata.value.dataType === undefined &&
    isBadStatus(metadata.value.attributeStatuses?.dataType)
  ) {
    reasons.push(
      reason(
        control,
        'control_target_datatype_unavailable',
        'Semantic Control target Node data type could not be inspected.',
      ),
    );
  }
  if (
    metadata.value.valueRank === undefined &&
    isBadStatus(metadata.value.attributeStatuses?.valueRank)
  ) {
    reasons.push(
      reason(
        control,
        'control_target_shape_unavailable',
        'Semantic Control target Node value shape could not be inspected.',
      ),
    );
  }
  if (
    (metadata.value.readable === undefined || metadata.value.writable === undefined) &&
    isBadStatus(metadata.value.attributeStatuses?.userAccessLevel)
  ) {
    reasons.push(
      reason(
        control,
        'control_target_access_unavailable',
        'Semantic Control target Node session access could not be inspected.',
      ),
    );
  }
  if (metadata.value.dataType !== undefined && metadata.value.dataType !== control.dataType) {
    reasons.push({
      ...reason(
        control,
        'control_target_datatype_mismatch',
        'Semantic Control target Node data type does not match configuration.',
      ),
      expectedDataType: control.dataType,
      actualDataType: metadata.value.dataType,
    });
  }
  if (metadata.value.valueRank !== undefined && metadata.value.valueRank !== SCALAR_VALUE_RANK) {
    reasons.push({
      ...reason(
        control,
        'control_target_unsupported_shape',
        'Semantic Control target Node must have a scalar value.',
      ),
      expectedValueRank: SCALAR_VALUE_RANK,
      actualValueRank: metadata.value.valueRank,
    });
  }
  return withMetadataEvidence(reasons, metadata.value);
}

function withMetadataEvidence(
  reasons: OnlineValidationReason[],
  metadata: NodeMetadataResult,
): OnlineValidationReason[] {
  return reasons.map((validationReason) => ({
    ...validationReason,
    ...metadataEvidence(metadata),
  }));
}

function metadataEvidence(metadata: NodeMetadataResult): Record<string, unknown> {
  if (metadata.attributeStatuses === undefined) return {};
  return { evidence: { attributeStatuses: metadata.attributeStatuses } };
}

function isBadStatus(status: string | undefined): boolean {
  return status !== undefined && !status.startsWith('Good');
}

function isAccessFailure(status: string | undefined): boolean {
  return isBadStatus(status) && status !== 'BadNodeIdUnknown';
}

function reason(control: ControlItem, code: string, message: string): OnlineValidationReason {
  return { code, message, nodeId: control.nodeId, controlName: control.name };
}

async function safeNodeMetadata(
  gateway: OpcUaGateway,
  nodeId: string,
): Promise<{ ok: true; value: NodeMetadataResult } | { ok: false; message: string }> {
  try {
    if (gateway.getNodeMetadata === undefined) return { ok: true, value: {} };
    return { ok: true, value: await gateway.getNodeMetadata(nodeId) };
  } catch (error) {
    return {
      ok: false,
      message: sanitizeMessage(
        error instanceof Error ? error.message : 'Online validation failed.',
      ),
    };
  }
}

function pendingValidation(status: OpcUaStatus): OnlineValidationResult {
  return {
    state: 'pending',
    connectionGeneration: status.connectionGeneration,
    reasons: [
      {
        code: 'online_validation_pending',
        message: 'Online validation is pending until the OPC UA Server is connected.',
        connection: { state: status.state, connectionGeneration: status.connectionGeneration },
      },
    ],
    controls: {},
    readRoots: [],
  };
}

function sanitizeMessage(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? 'Online validation failed.';
}
