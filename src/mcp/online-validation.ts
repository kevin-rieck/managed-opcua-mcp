import type { AppConfig } from '../config/schema.js';
import type { NodeMetadataResult, OpcUaGateway, OpcUaStatus } from '../opcua/gateway.js';
import { statusSeverity } from '../opcua/status-code.js';

export type OnlineValidationState = 'pending' | 'valid' | 'invalid';

export interface OnlineValidationReason extends Record<string, unknown> {
  code: string;
  message: string;
  nodeId?: string;
  label?: string;
}

export interface OnlineValidationResult {
  state: OnlineValidationState;
  connectionGeneration: number;
  reasons: OnlineValidationReason[];
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

async function validateOnlineConfig(
  config: AppConfig,
  gateway: OpcUaGateway,
  status: OpcUaStatus,
): Promise<OnlineValidationResult> {
  const readRoots: OnlineValidationReason[] = [];

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
      const unavailable = metadata.value.exists === false && isAccessFailure(metadata.value);
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

  const reasons = [...readRoots];
  return {
    state: reasons.length === 0 ? 'valid' : 'invalid',
    connectionGeneration: status.connectionGeneration,
    reasons,
    readRoots,
  };
}

function metadataEvidence(metadata: NodeMetadataResult): Record<string, unknown> {
  if (metadata.attributeStatuses === undefined) return {};
  return {
    evidence: {
      attributeStatuses: metadata.attributeStatuses,
      ...(metadata.attributeStatusCodes
        ? { attributeStatusCodes: metadata.attributeStatusCodes }
        : {}),
    },
  };
}

function isBadStatus(
  metadata: NodeMetadataResult,
  key: keyof NonNullable<NodeMetadataResult['attributeStatuses']>,
): boolean {
  if (metadata.attributeStatusCodes !== undefined) {
    const status = metadata.attributeStatusCodes[key];
    return status === undefined || statusSeverity(status) !== 'good';
  }
  const status = metadata.attributeStatuses?.[key];
  return status !== undefined && !status.startsWith('Good');
}

function isAccessFailure(metadata: NodeMetadataResult): boolean {
  if (!isBadStatus(metadata, 'nodeId')) return false;
  const numeric = metadata.attributeStatusCodes?.nodeId;
  return numeric
    ? numeric.value >>> 16 !== 0x8034
    : metadata.attributeStatusCodes !== undefined ||
        metadata.attributeStatuses?.nodeId !== 'BadNodeIdUnknown';
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
    readRoots: [],
  };
}

function sanitizeMessage(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? 'Online validation failed.';
}
