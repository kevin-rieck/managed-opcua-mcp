import type { AuditHealth, AuditSink } from '../audit/audit-sink.js';
import type { AppConfig, ControlItem } from '../config/schema.js';
import type { OpcUaGateway, OpcUaStatus } from '../opcua/gateway.js';

export interface ResourceDependencies {
  config: AppConfig;
  configHash: string;
  gateway: OpcUaGateway;
  auditSink: AuditSink;
}

export async function buildStatusResource({
  config,
  configHash,
  gateway,
  auditSink,
}: ResourceDependencies): Promise<Record<string, unknown>> {
  const [gatewayStatus, auditHealth] = await Promise.all([safeGatewayStatus(gateway), safeAuditHealth(auditSink)]);
  const controls = summarizeControls(config.controls?.items ?? [], config.controls?.enabled ?? false);

  return {
    connection: sanitizeGatewayStatus(gatewayStatus),
    onlineValidation: { state: 'pending' },
    controls,
    audit: auditHealth,
    configHash,
  };
}

export function buildConfigSummaryResource(config: AppConfig, configHash: string): Record<string, unknown> {
  return {
    version: config.version,
    connection: redactConnection(config.connection),
    read: config.read,
    audit: config.audit,
    controls:
      config.controls === undefined
        ? { enabled: false, configured: 0 }
        : {
            enabled: config.controls.enabled,
            configured: config.controls.items.length,
            defaults: config.controls.defaults,
          },
    configHash,
  };
}

export function buildReadEntryPointsResource(config: AppConfig): Record<string, unknown> {
  return config.read;
}

export function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function summarizeControls(items: ControlItem[], enabled: boolean): Record<string, unknown> {
  return {
    configured: items.length,
    lowRisk: items.filter((control) => control.riskLevel === 'low').length,
    mediumRisk: items.filter((control) => control.riskLevel === 'medium').length,
    enabled,
  };
}

async function safeGatewayStatus(gateway: OpcUaGateway): Promise<OpcUaStatus> {
  try {
    return await gateway.status();
  } catch (error) {
    return {
      state: 'disconnected',
      connectionGeneration: 0,
      lastError: {
        code: 'status_unavailable',
        message: error instanceof Error ? error.message : 'OPC UA status unavailable.',
        at: new Date().toISOString(),
      },
    };
  }
}

async function safeAuditHealth(auditSink: AuditSink): Promise<AuditHealth> {
  try {
    return await auditSink.health();
  } catch (error) {
    return { healthy: false, reason: sanitizeMessage(error instanceof Error ? error.message : 'Audit health unavailable.') };
  }
}

function sanitizeGatewayStatus(status: OpcUaStatus): Record<string, unknown> {
  return {
    ...status,
    lastError:
      status.lastError === undefined
        ? undefined
        : {
            code: status.lastError.code,
            message: sanitizeMessage(status.lastError.message),
            at: status.lastError.at,
          },
  };
}

function sanitizeMessage(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? 'unknown error';
}

function redactConnection(connection: AppConfig['connection']): Record<string, unknown> {
  return {
    ...connection,
    auth:
      connection.auth.type === 'anonymous'
        ? { type: 'anonymous' }
        : { type: 'usernamePassword', username: '[redacted]', password: '[redacted]' },
  };
}
