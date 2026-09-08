import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import { appendControlAuditRecord, requireHealthyAudit } from '../audit/control-audit.js';
import type { ControlItem } from '../config/schema.js';
import { normalizeControlValue } from '../control/value-normalization.js';
import { resolveReadEntryPointLabel } from '../policy/read-entry-points.js';
import { requireConnectedOpcUa } from './live-opcua-preflight.js';
import {
  getOnlineValidation,
  validationReasonsForControl,
  type OnlineValidationCache,
  type OnlineValidationResult,
} from './online-validation.js';
import type { OpcUaGateway } from '../opcua/gateway.js';
import { createOpcUaInspectionModule, type OpcUaInspectionService } from '../opcua/inspection-module.js';
import type { NodeSelector, OpcUaInspectionModule } from '../opcua/inspection-contracts.js';
import type { ReadOnlyOpcUaProtocolAdapter } from '../opcua/read-only-protocol.js';
import {
  buildConfigSummaryResource,
  buildReadEntryPointsResource,
  buildStatusResource,
  jsonResource,
} from './resources.js';

export interface McpServerDependencies {
  config: AppConfig;
  configHash: string;
  gateway: OpcUaGateway;
  auditSink: AuditSink;
  /** Optional native read-only module supplied by the connection integration. */
  inspection?: OpcUaInspectionModule;
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({ name: 'opcua-mcp-server', version: '0.1.0' });
  const writeState: WriteControlState = {
    lastWriteAtByControlName: new Map(),
    confirmationTokens: new Map(),
  };
  const onlineValidationCache: OnlineValidationCache = {};
  const inspection =
    dependencies.inspection ?? createInspectionFromGateway(dependencies.gateway, dependencies.config);

  server.registerResource(
    'status',
    'opcua://status',
    {
      title: 'OPC UA MCP Server status',
      description: 'Safe operational status for the MCP Server and OPC UA connection.',
      mimeType: 'application/json',
    },
    async () => {
      const status = await buildStatusResource(dependencies);
      status['onlineValidation'] = await getOnlineValidation(
        dependencies.config,
        dependencies.gateway,
        onlineValidationCache,
      );
      return jsonResource('opcua://status', status);
    },
  );

  server.registerResource(
    'config_summary',
    'opcua://config/summary',
    {
      title: 'OPC UA MCP Server config summary',
      description: 'Non-secret local configuration summary with auth fields redacted.',
      mimeType: 'application/json',
    },
    () =>
      jsonResource(
        'opcua://config/summary',
        buildConfigSummaryResource(dependencies.config, dependencies.configHash),
      ),
  );

  server.registerResource(
    'read_entry_points',
    'opcua://read-entry-points',
    {
      title: 'OPC UA MCP Server Read Entry Points',
      description: 'Configured Read Entry Points for discovery without live browsing.',
      mimeType: 'application/json',
    },
    () =>
      jsonResource('opcua://read-entry-points', buildReadEntryPointsResource(dependencies.config)),
  );

  server.registerResource(
    'model_context',
    'opcua://model-context',
    {
      title: 'OPC UA model context',
      description: 'Live namespace qualification and best-effort NamespaceMetadata context.',
      mimeType: 'application/json',
    },
    async () =>
      jsonResource(
        'opcua://model-context',
        inspection === undefined
          ? {
              ok: false,
              error: {
                code: 'opcua_operation_failed',
                message: 'The read-only OPC UA inspection module is unavailable.',
              },
            }
          : await inspection.modelContext(),
      ),
  );

  if ((dependencies.config.controls?.items.length ?? 0) > 0) {
    server.registerTool(
      'list_controls',
      {
        title: 'List Semantic Controls',
        description: 'List Operator-defined Semantic Controls and their current availability.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => toolJson(await listControlsTool(dependencies, onlineValidationCache)),
    );

    server.registerTool(
      'prepare_control',
      {
        title: 'Prepare medium-risk Semantic Control',
        description: 'Prepare a medium-risk Semantic Control Operation and return a confirmation token.',
        inputSchema: {
          controlName: z.string().min(1),
          value: z.unknown(),
          reason: z.string().min(1),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ controlName, value, reason }) =>
        toolJson(
          await prepareControlTool(dependencies, writeState, onlineValidationCache, {
            controlName,
            value,
            reason,
          }),
        ),
    );

    server.registerTool(
      'commit_control',
      {
        title: 'Commit medium-risk Semantic Control',
        description: 'Commit a prepared medium-risk Semantic Control Operation by token.',
        inputSchema: { token: z.string().min(1) },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ token }) =>
        toolJson(await commitControlTool(dependencies, writeState, onlineValidationCache, { token })),
    );

    server.registerTool(
      'write_control',
      {
        title: 'Write low-risk Semantic Control',
        description: 'Perform a low-risk Operator-defined Semantic Control Operation.',
        inputSchema: {
          controlName: z.string().min(1),
          value: z.unknown(),
          reason: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ controlName, value, reason }) => {
        const args: WriteControlArgs = { controlName, value };
        if (reason !== undefined) args.reason = reason;
        return toolJson(await writeControlTool(dependencies, writeState, onlineValidationCache, args));
      },
    );
  }

  server.registerTool(
    'browse_node',
    {
      title: 'Browse OPC UA Node',
      description: 'Browse qualified OPC UA references from a NodeId or Read Entry Point label.',
      inputSchema: {
        nodeId: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        continuation: z.string().min(1).optional(),
        direction: z.enum(['forward', 'inverse', 'both']).optional(),
        referenceScope: z.enum(['hierarchical', 'all']).optional(),
        targetNodeClasses: z
          .array(z.enum(['Object', 'Variable', 'Method', 'ObjectType', 'VariableType', 'ReferenceType', 'DataType', 'View']))
          .optional(),
        depth: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nodeId, label, continuation, direction, referenceScope, targetNodeClasses, depth, pageSize }) => {
      if (inspection === undefined) return toolJson(inspectionUnavailable());
      if (continuation !== undefined) {
        if (nodeId !== undefined || label !== undefined || direction !== undefined || referenceScope !== undefined || targetNodeClasses !== undefined || depth !== undefined || pageSize !== undefined)
          return toolJson({ ok: false, error: { code: 'invalid_request', message: 'A continuation request accepts only continuation.' } });
        return toolJson(await inspection.browse({ continuation }));
      }
      if (nodeId === undefined && label === undefined)
        return toolJson({ ok: false, error: { code: 'invalid_request', message: 'Provide a NodeId or Read Entry Point label.' } });
      return toolJson(
        await inspection.browse({
          selector: nodeSelector(nodeId, label),
          ...(direction === undefined ? {} : { direction }),
          ...(referenceScope === undefined ? {} : { referenceScope }),
          ...(targetNodeClasses === undefined ? {} : { targetNodeClasses }),
          ...(depth === undefined ? {} : { depth }),
          ...(pageSize === undefined ? {} : { pageSize }),
        }),
      );
    },
  );

  server.registerTool(
    'inspect_node',
    {
      title: 'Inspect OPC UA Node',
      description: 'Inspect qualified identity and fixed OPC UA metadata for one Node.',
      inputSchema: {
        nodeId: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nodeId, label }) => {
      if (inspection === undefined) return toolJson(inspectionUnavailable());
      return toolJson(await inspection.inspect({ selector: nodeSelector(nodeId, label) }));
    },
  );

  server.registerTool(
    'inspect_nodes',
    {
      title: 'Inspect OPC UA Nodes',
      description: 'Inspect qualified identity and fixed OPC UA metadata for Nodes.',
      inputSchema: {
        selectors: z.array(z.object({ nodeId: z.string().min(1).optional(), label: z.string().min(1).optional() })).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ selectors }) => {
      if (inspection === undefined) return toolJson(inspectionUnavailable());
      return toolJson(await inspection.inspect({ selectors: selectors.map(({ nodeId, label }) => nodeSelector(nodeId, label)) }));
    },
  );

  server.registerTool(
    'read_node',
    {
      title: 'Read OPC UA Node',
      description: 'Read one OPC UA Node by NodeId or Read Entry Point label.',
      inputSchema: {
        nodeId: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nodeId, label }) => {
      if (inspection === undefined) return toolJson(inspectionUnavailable());
      return toolJson(await inspection.read({ selector: nodeSelector(nodeId, label) }));
    },
  );

  server.registerTool(
    'read_nodes',
    {
      title: 'Read OPC UA Nodes',
      description: 'Read current values for a bounded batch of OPC UA Nodes.',
      inputSchema: {
        selectors: z.array(z.object({ nodeId: z.string().min(1).optional(), label: z.string().min(1).optional() })).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ selectors }) => {
      if (inspection === undefined) return toolJson(inspectionUnavailable());
      return toolJson(await inspection.read({ selectors: selectors.map(({ nodeId, label }) => nodeSelector(nodeId, label)) }));
    },
  );

  return server;
}

interface WriteControlArgs {
  controlName: string;
  value: unknown;
  reason?: string;
}

interface CommitControlArgs {
  token: string;
}

interface WriteControlState {
  lastWriteAtByControlName: Map<string, number>;
  confirmationTokens: Map<string, ConfirmationToken>;
}

interface ConfirmationToken {
  controlName: string;
  requestedValue: unknown;
  rawRequestedValue: unknown;
  reason: string;
  configHash: string;
  connectionGeneration: number;
  expiresAt: number;
  observedCurrentRawValue?: unknown;
}

async function listControlsTool(
  dependencies: McpServerDependencies,
  onlineValidationCache: OnlineValidationCache,
): Promise<Record<string, unknown>> {
  const controls = dependencies.config.controls?.items ?? [];
  const defaultCooldownMs = dependencies.config.controls?.defaults.cooldownMs ?? 0;
  const controlsEnabled = dependencies.config.controls?.enabled ?? false;
  const status = await dependencies.gateway.status();
  const auditHealth = await dependencies.auditSink.health();
  const onlineValidation = await getOnlineValidation(
    dependencies.config,
    dependencies.gateway,
    onlineValidationCache,
  );
  return {
    ok: true,
    controls: controls.map((control) => {
      const unavailableReasons: Record<string, unknown>[] = [];
      if (!controlsEnabled) {
        unavailableReasons.push({
          code: 'controls_disabled',
          message: 'Semantic Controls are disabled.',
        });
      }
      if (status.state !== 'connected') {
        unavailableReasons.push({
          code: 'opcua_disconnected',
          message: 'OPC UA Server is not connected.',
          connection: {
            state: status.state,
            connectionGeneration: status.connectionGeneration,
          },
        });
      }
      if (!auditHealth.healthy) {
        unavailableReasons.push({
          code: 'audit_unavailable',
          message: `Audit logging is unavailable: ${auditHealth.reason}`,
        });
      }
      const onlineValidationReasons = validationReasonsForControl(onlineValidation, control.name);
      unavailableReasons.push(...onlineValidationReasons);
      return {
        name: control.name,
        ...(control.group !== undefined ? { group: control.group } : {}),
        description: control.description,
        nodeId: control.nodeId,
        riskLevel: control.riskLevel,
        riskNote: control.riskNote,
        requiresConfirmation: control.riskLevel === 'medium',
        requiresReason: control.riskLevel === 'medium',
        ...(control.requireCurrentValueForConfirmation !== undefined
          ? { requireCurrentValueForConfirmation: control.requireCurrentValueForConfirmation }
          : {}),
        value: buildControlValueMetadata(control),
        cooldownMs: control.cooldownMs ?? defaultCooldownMs,
        available: unavailableReasons.length === 0,
        unavailableReasons,
        ...(onlineValidationReasons.length > 0
          ? { onlineValidation: { state: 'invalid', reasons: onlineValidationReasons } }
          : {}),
      };
    }),
  };
}

async function prepareControlTool(
  dependencies: McpServerDependencies,
  state: WriteControlState,
  onlineValidationCache: OnlineValidationCache,
  args: Required<WriteControlArgs>,
): Promise<Record<string, unknown>> {
  const control = dependencies.config.controls?.items.find(
    (candidate) => candidate.name === args.controlName,
  );
  if (control === undefined) {
    return {
      ok: false,
      code: 'unknown_control',
      message: `Unknown Semantic Control: ${args.controlName}`,
    };
  }

  if (dependencies.config.controls?.enabled !== true) {
    return {
      ok: false,
      code: 'controls_disabled',
      message: 'Semantic Controls are disabled.',
    };
  }

  if (control.riskLevel !== 'medium') {
    return {
      ok: false,
      code: 'confirmation_not_required',
      message: 'Only medium-risk Semantic Controls use Control Confirmation.',
    };
  }

  const auditPreflight = await requireHealthyAudit(dependencies.auditSink);
  if (!auditPreflight.ok) return auditPreflight;

  const connectionPreflight = await requireConnectedOpcUa(dependencies.gateway);
  if (!connectionPreflight.ok) return connectionPreflight.response;

  const onlinePreflight = await requireOnlineValidControl(
    dependencies,
    onlineValidationCache,
    control.name,
  );
  if (!onlinePreflight.ok) return onlinePreflight.response;

  const normalized = normalizeWriteControlValue(control, args.value);
  if (!normalized.ok) {
    const append = await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        event: 'control.prepare.rejected',
        result: 'rejected',
        controlName: control.name,
        nodeId: control.nodeId,
        riskLevel: control.riskLevel,
        configHash: dependencies.configHash,
        reason: args.reason,
        errorMessage: normalized.message,
      },
    });
    return {
      ok: false,
      code: 'invalid_control_value',
      message: normalized.message,
      controlName: control.name,
      auditId: append.id,
    };
  }

  const currentValue = await readCurrentControlValue(dependencies.gateway, control);
  if (!currentValue.ok && control.requireCurrentValueForConfirmation === true) {
    const append = await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        event: 'control.prepare.rejected',
        result: 'rejected',
        controlName: control.name,
        nodeId: control.nodeId,
        requestedValue: normalized.value,
        rawRequestedValue: normalized.rawValue,
        riskLevel: control.riskLevel,
        configHash: dependencies.configHash,
        reason: args.reason,
        errorMessage: currentValue.message ?? 'Current value unavailable.',
      },
    });
    return { ...currentValue, controlName: control.name, auditId: append.id };
  }

  const token = randomUUID();
  const expiresAtMs = Date.now() + dependencies.config.controls.defaults.mediumConfirmationTtlMs;
  state.confirmationTokens.set(token, {
    controlName: control.name,
    requestedValue: normalized.value,
    rawRequestedValue: normalized.rawValue,
    reason: args.reason,
    configHash: dependencies.configHash,
    connectionGeneration: connectionPreflight.connection.connectionGeneration,
    expiresAt: expiresAtMs,
    ...(currentValue.ok && currentValue.rawValue !== undefined
      ? { observedCurrentRawValue: currentValue.rawValue }
      : {}),
  });

  const append = await appendControlAuditRecord(dependencies.auditSink, {
    maxReasonLength: dependencies.config.audit.maxReasonLength,
    record: {
      event: 'control.prepare.completed',
      result: 'prepared',
      controlName: control.name,
      nodeId: control.nodeId,
      requestedValue: normalized.value,
      rawRequestedValue: normalized.rawValue,
      riskLevel: control.riskLevel,
      configHash: dependencies.configHash,
      reason: args.reason,
    },
  });

  return {
    ok: true,
    token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    auditId: append.id,
    controlName: control.name,
    nodeId: control.nodeId,
    description: control.description,
    requestedValue: normalized.value,
    rawRequestedValue: normalized.rawValue,
    riskLevel: control.riskLevel,
    riskNote: control.riskNote,
    currentValue,
    commitAvailable: true,
  };
}

async function readCurrentControlValue(
  gateway: OpcUaGateway,
  control: ControlItem,
): Promise<Record<string, unknown> & { ok: boolean; rawValue?: unknown; message?: string }> {
  try {
    const read = await gateway.read(control.nodeId);
    const normalized = normalizeReadValue(control, read.value);
    return {
      ok: true,
      value: normalized.value,
      ...(normalized.rawValueIncluded ? { rawValue: normalized.rawValue } : {}),
      ...(read.opcuaStatus !== undefined ? { opcuaStatus: read.opcuaStatus } : {}),
    };
  } catch (error) {
    return { ok: false, ...sanitizeToolError(error, 'opcua_read_failed') };
  }
}

async function commitControlTool(
  dependencies: McpServerDependencies,
  state: WriteControlState,
  onlineValidationCache: OnlineValidationCache,
  args: CommitControlArgs,
): Promise<Record<string, unknown>> {
  const token = state.confirmationTokens.get(args.token);
  // Confirmation tokens are opaque random UUIDs, not secrets compared in constant-time contexts.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (token === undefined) {
    const append = await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        event: 'control.commit.rejected',
        result: 'rejected',
        configHash: dependencies.configHash,
        errorMessage: 'Invalid confirmation token.',
      },
    });
    return {
      ok: false,
      code: 'invalid_confirmation_token',
      message: 'Invalid confirmation token.',
      auditId: append.id,
    };
  }

  const control = dependencies.config.controls?.items.find(
    (candidate) => candidate.name === token.controlName,
  );
  if (control === undefined) {
    state.confirmationTokens.delete(args.token);
    return { ok: false, code: 'unknown_control', message: `Unknown Semantic Control: ${token.controlName}` };
  }

  if (dependencies.config.controls?.enabled !== true) {
    return { ok: false, code: 'controls_disabled', message: 'Semantic Controls are disabled.' };
  }

  if (Date.now() > token.expiresAt) {
    state.confirmationTokens.delete(args.token);
    const append = await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        event: 'control.commit.rejected',
        result: 'rejected',
        controlName: control.name,
        nodeId: control.nodeId,
        requestedValue: token.requestedValue,
        rawRequestedValue: token.rawRequestedValue,
        riskLevel: control.riskLevel,
        configHash: dependencies.configHash,
        reason: token.reason,
        errorMessage: 'Confirmation token expired.',
      },
    });
    return {
      ok: false,
      code: 'confirmation_token_expired',
      message: 'Confirmation token expired.',
      auditId: append.id,
    };
  }

  const auditPreflight = await requireHealthyAudit(dependencies.auditSink);
  if (!auditPreflight.ok) return auditPreflight;

  const connectionPreflight = await requireConnectedOpcUa(dependencies.gateway);
  if (!connectionPreflight.ok) return connectionPreflight.response;

  const onlinePreflight = await requireOnlineValidControl(
    dependencies,
    onlineValidationCache,
    control.name,
  );
  if (!onlinePreflight.ok) return onlinePreflight.response;

  if (connectionPreflight.connection.connectionGeneration !== token.connectionGeneration) {
    state.confirmationTokens.delete(args.token);
    await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        event: 'control.commit.rejected',
        result: 'rejected',
        controlName: control.name,
        nodeId: control.nodeId,
        requestedValue: token.requestedValue,
        rawRequestedValue: token.rawRequestedValue,
        riskLevel: control.riskLevel,
        configHash: dependencies.configHash,
        reason: token.reason,
        errorMessage: 'Connection changed after prepare.',
      },
    });
    return {
      ok: false,
      code: 'confirmation_token_connection_changed',
      message: 'OPC UA connection changed after prepare.',
    };
  }

  const cooldownMs = control.cooldownMs ?? dependencies.config.controls.defaults.cooldownMs;
  const lastWriteAt = state.lastWriteAtByControlName.get(control.name);
  if (lastWriteAt !== undefined) {
    const remainingCooldownMs = cooldownMs - (Date.now() - lastWriteAt);
    if (remainingCooldownMs > 0) {
      return {
        ok: false,
        code: 'control_cooldown_active',
        message: 'Semantic Control cooldown is active.',
        controlName: control.name,
        cooldownMs,
        remainingCooldownMs,
      };
    }
  }

  const auditBase = {
    controlName: control.name,
    nodeId: control.nodeId,
    requestedValue: token.requestedValue,
    rawRequestedValue: token.rawRequestedValue,
    riskLevel: control.riskLevel,
    configHash: dependencies.configHash,
    reason: token.reason,
  };

  if (token.observedCurrentRawValue !== undefined) {
    const currentValue = await readCurrentControlValue(dependencies.gateway, control);
    if (!currentValue.ok || currentValue.rawValue !== token.observedCurrentRawValue) {
      const append = await appendControlAuditRecord(dependencies.auditSink, {
        maxReasonLength: dependencies.config.audit.maxReasonLength,
        record: {
          ...auditBase,
          event: 'control.commit.rejected',
          result: 'rejected',
          errorMessage: currentValue.ok
            ? 'Current value changed after prepare.'
            : (currentValue.message ?? 'Current value unavailable.'),
        },
      });
      return {
        ok: false,
        code: currentValue.ok ? 'confirmation_current_value_changed' : 'opcua_read_failed',
        message: currentValue.ok
          ? 'Current value changed after prepare.'
          : (currentValue.message ?? 'Current value unavailable.'),
        controlName: control.name,
        currentValue,
        auditId: append.id,
      };
    }
  }

  await appendControlAuditRecord(dependencies.auditSink, {
    maxReasonLength: dependencies.config.audit.maxReasonLength,
    record: { ...auditBase, event: 'control.commit.requested', result: 'accepted' },
  });

  let write;
  try {
    write = await dependencies.gateway.write(control.nodeId, control.dataType, token.rawRequestedValue);
  } catch (error) {
    const sanitized = sanitizeToolError(error, 'opcua_write_failed');
    await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        ...auditBase,
        event: 'control.commit.failed',
        result: 'failed',
        errorMessage: sanitized.message,
      },
    });
    return { ok: false, ...sanitized, controlName: control.name, nodeId: control.nodeId };
  }

  const verification = await verifyControlWrite(dependencies.gateway, control, token.rawRequestedValue);
  await appendControlAuditRecord(dependencies.auditSink, {
    maxReasonLength: dependencies.config.audit.maxReasonLength,
    record: {
      ...auditBase,
      event: 'control.commit.completed',
      result: writeCompletionAuditResult(verification),
      opcuaStatus: write.opcuaStatus,
    },
  });
  state.confirmationTokens.delete(args.token);
  state.lastWriteAtByControlName.set(control.name, Date.now());

  return {
    ok: verification.ok,
    ...(verification.ok ? {} : { code: writeCompletionResponseCode(verification) }),
    controlName: control.name,
    nodeId: control.nodeId,
    requestedValue: token.requestedValue,
    rawRequestedValue: token.rawRequestedValue,
    riskLevel: control.riskLevel,
    opcuaStatus: write.opcuaStatus,
    verification,
  };
}

async function writeControlTool(
  dependencies: McpServerDependencies,
  state: WriteControlState,
  onlineValidationCache: OnlineValidationCache,
  args: WriteControlArgs,
): Promise<Record<string, unknown>> {
  const control = dependencies.config.controls?.items.find(
    (candidate) => candidate.name === args.controlName,
  );
  if (control === undefined) {
    return {
      ok: false,
      code: 'unknown_control',
      message: `Unknown Semantic Control: ${args.controlName}`,
    };
  }

  if (dependencies.config.controls?.enabled !== true) {
    return {
      ok: false,
      code: 'controls_disabled',
      message: 'Semantic Controls are disabled.',
    };
  }

  if (control.riskLevel === 'medium') {
    return {
      ok: false,
      code: 'confirmation_required',
      message: 'Medium-risk Semantic Controls require prepare_control and commit_control.',
    };
  }

  const cooldownMs = control.cooldownMs ?? dependencies.config.controls.defaults.cooldownMs;
  const lastWriteAt = state.lastWriteAtByControlName.get(control.name);
  if (lastWriteAt !== undefined) {
    const remainingCooldownMs = cooldownMs - (Date.now() - lastWriteAt);
    if (remainingCooldownMs > 0) {
      return {
        ok: false,
        code: 'control_cooldown_active',
        message: 'Semantic Control cooldown is active.',
        controlName: control.name,
        cooldownMs,
        remainingCooldownMs,
      };
    }
  }

  const auditPreflight = await requireHealthyAudit(dependencies.auditSink);
  if (!auditPreflight.ok) return auditPreflight;

  const connectionPreflight = await requireConnectedOpcUa(dependencies.gateway);
  if (!connectionPreflight.ok) return connectionPreflight.response;

  const onlinePreflight = await requireOnlineValidControl(
    dependencies,
    onlineValidationCache,
    control.name,
  );
  if (!onlinePreflight.ok) return onlinePreflight.response;

  const normalized = normalizeWriteControlValue(control, args.value);
  if (!normalized.ok) {
    return {
      ok: false,
      code: 'invalid_control_value',
      message: normalized.message,
      controlName: control.name,
    };
  }

  const auditBase = {
    controlName: control.name,
    nodeId: control.nodeId,
    requestedValue: normalized.value,
    rawRequestedValue: normalized.rawValue,
    riskLevel: control.riskLevel,
    configHash: dependencies.configHash,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  };

  await appendControlAuditRecord(dependencies.auditSink, {
    maxReasonLength: dependencies.config.audit.maxReasonLength,
    record: { ...auditBase, event: 'control.write.requested', result: 'accepted' },
  });

  let write;
  try {
    write = await dependencies.gateway.write(control.nodeId, control.dataType, normalized.rawValue);
  } catch (error) {
    const sanitized = sanitizeToolError(error, 'opcua_write_failed');
    await appendControlAuditRecord(dependencies.auditSink, {
      maxReasonLength: dependencies.config.audit.maxReasonLength,
      record: {
        ...auditBase,
        event: 'control.write.failed',
        result: 'failed',
        errorMessage: sanitized.message,
      },
    });
    return {
      ok: false,
      ...sanitized,
      controlName: control.name,
      nodeId: control.nodeId,
    };
  }

  const verification = await verifyControlWrite(dependencies.gateway, control, normalized.rawValue);

  await appendControlAuditRecord(dependencies.auditSink, {
    maxReasonLength: dependencies.config.audit.maxReasonLength,
    record: {
      ...auditBase,
      event: 'control.write.completed',
      result: writeCompletionAuditResult(verification),
      opcuaStatus: write.opcuaStatus,
    },
  });
  state.lastWriteAtByControlName.set(control.name, Date.now());

  return {
    ok: verification.ok,
    ...(verification.ok ? {} : { code: writeCompletionResponseCode(verification) }),
    controlName: control.name,
    nodeId: control.nodeId,
    requestedValue: normalized.value,
    rawRequestedValue: normalized.rawValue,
    riskLevel: control.riskLevel,
    opcuaStatus: write.opcuaStatus,
    verification,
  };
}

async function requireOnlineValidControl(
  dependencies: McpServerDependencies,
  onlineValidationCache: OnlineValidationCache,
  controlName: string,
): Promise<{ ok: true; validation: OnlineValidationResult } | { ok: false; response: Record<string, unknown> }> {
  const validation = await getOnlineValidation(
    dependencies.config,
    dependencies.gateway,
    onlineValidationCache,
  );
  const reasons = validationReasonsForControl(validation, controlName);
  if (validation.state === 'pending' || reasons.length === 0) return { ok: true, validation };
  return {
    ok: false,
    response: {
      ok: false,
      code: 'online_validation_failed',
      message: 'Semantic Control is unavailable because online validation failed.',
      controlName,
      onlineValidation: { state: 'invalid', reasons },
    },
  };
}

async function verifyControlWrite(
  gateway: OpcUaGateway,
  control: ControlItem,
  rawRequestedValue: unknown,
): Promise<Record<string, unknown> & { ok: boolean }> {
  try {
    const read = await gateway.read(control.nodeId);
    const normalized = normalizeReadValue(control, read.value);
    return {
      ok: read.value === rawRequestedValue,
      value: normalized.value,
      ...(normalized.rawValueIncluded ? { rawValue: normalized.rawValue } : {}),
      ...(read.opcuaStatus !== undefined ? { opcuaStatus: read.opcuaStatus } : {}),
    };
  } catch (error) {
    const sanitized = sanitizeToolError(error, 'opcua_read_failed');
    return { ok: false, code: 'verification_unavailable', message: sanitized.message };
  }
}

function writeCompletionResponseCode(verification: Record<string, unknown>): string {
  return verification['code'] === 'verification_unavailable'
    ? 'write_outcome_unknown'
    : 'write_accepted_verification_failed';
}

function writeCompletionAuditResult(verification: Record<string, unknown> & { ok: boolean }): string {
  if (verification.ok) return 'succeeded';
  return verification['code'] === 'verification_unavailable' ? 'unknown_outcome' : 'verification_failed';
}

function normalizeWriteControlValue(
  control: ControlItem,
  value: unknown,
):
  | { ok: true; value: unknown; rawValue: unknown }
  | { ok: false; message: string } {
  try {
    return { ok: true, ...normalizeControlValue(control, value) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? sanitizeToolMessage(error.message) : 'Invalid control value.',
    };
  }
}

function buildControlValueMetadata(control: ControlItem): Record<string, unknown> {
  if (control.dataType === 'Boolean') {
    return { type: 'boolean', falseLabel: control.falseLabel, trueLabel: control.trueLabel };
  }
  if ('allowedValues' in control) {
    return { type: 'enum', dataType: control.dataType, allowedValues: control.allowedValues };
  }
  return {
    type: 'number',
    dataType: control.dataType,
    min: control.min,
    max: control.max,
    unit: control.unit,
  };
}

function normalizeReadValue(
  control: ControlItem | undefined,
  value: unknown,
): { value: unknown; rawValue: unknown; rawValueIncluded: boolean } {
  if (control?.dataType === 'Boolean' && typeof value === 'boolean') {
    return {
      value: value ? control.trueLabel : control.falseLabel,
      rawValue: value,
      rawValueIncluded: true,
    };
  }

  if (control !== undefined && 'allowedValues' in control) {
    const allowed = control.allowedValues.find((candidate) => candidate.value === value);
    if (allowed !== undefined)
      return { value: allowed.label, rawValue: value, rawValueIncluded: true };
  }

  return { value, rawValue: value, rawValueIncluded: false };
}

function toolJson(body: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function nodeSelector(nodeId: string | undefined, label: string | undefined): NodeSelector {
  if (nodeId !== undefined && label !== undefined)
    return { nodeId, label } as unknown as NodeSelector;
  if (nodeId === undefined) {
    if (label === undefined) return {} as NodeSelector;
    return { label };
  }
  return { nodeId };
}

function inspectionUnavailable(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'opcua_operation_failed',
      message: 'The read-only OPC UA inspection module is unavailable.',
    },
  };
}

function sanitizeToolError(error: unknown, defaultCode: string): { code: string; message: string } {
  const message = error instanceof Error ? error.message : 'OPC UA browse failed.';
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : defaultCode;
  return { code, message: sanitizeToolMessage(message) };
}

function sanitizeToolMessage(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? 'OPC UA operation failed.';
}

function createInspectionFromGateway(
  gateway: OpcUaGateway,
  config: AppConfig,
): OpcUaInspectionModule | undefined {
  const candidate = gateway as OpcUaGateway & {
    readOnlyProtocol?: () => ReadOnlyOpcUaProtocolAdapter;
  };
  const adapter = candidate.readOnlyProtocol?.();
  if (adapter === undefined) return undefined;
  const read = config.read;
  const inspection = createOpcUaInspectionModule(adapter, {
    resolveLabel: (label) => resolveReadEntryPointLabel(config, label),
    ...(read.maxResponseBytes === undefined ? {} : { maximumResponseBytes: read.maxResponseBytes }),
    ...(read.maxInspectionBatchSize === undefined
      ? {}
      : { maximumInspectionBatchSize: read.maxInspectionBatchSize }),
    maximumReadBatchSize: read.maxReadBatchSize,
    defaultBrowseDepth: read.defaultBrowseDepth,
    maximumBrowseDepth: read.maxBrowseDepth,
    ...(read.maxBrowsePageSize === undefined
      ? {}
      : { maximumBrowsePageSize: read.maxBrowsePageSize }),
    ...(read.maxArrayElements === undefined ? {} : { maximumArrayElements: read.maxArrayElements }),
    ...(read.maxBrowseEdges === undefined ? {} : { maximumBrowseEdges: read.maxBrowseEdges }),
    ...(read.maxScannedReferences === undefined
      ? {}
      : { maximumScannedReferences: read.maxScannedReferences }),
    ...(read.maxExpandedNodes === undefined
      ? {}
      : { maximumExpandedNodes: read.maxExpandedNodes }),
    ...(read.maxBrowseServiceCalls === undefined
      ? {}
      : { maximumBrowseServiceCalls: read.maxBrowseServiceCalls }),
    ...(read.cursorTtlMs === undefined ? {} : { cursorTtlMs: read.cursorTtlMs }),
    ...(read.maxActiveCursors === undefined
      ? {}
      : { maximumActiveCursors: read.maxActiveCursors }),
    ...(read.maxConcurrentOperations === undefined
      ? {}
      : { maximumConcurrentOperations: read.maxConcurrentOperations }),
    ...(read.operationDeadlineMs === undefined
      ? {}
      : { operationDeadlineMs: read.operationDeadlineMs }),
  });
  const generationAwareGateway = gateway as OpcUaGateway & {
    onInspectionGenerationChange?: (listener: () => void) => void;
  };
  generationAwareGateway.onInspectionGenerationChange?.(() =>
    (inspection as OpcUaInspectionService).clearGenerationState(),
  );
  return inspection;
}

export async function startMcpServer(dependencies: McpServerDependencies): Promise<void> {
  void dependencies.gateway.connect();
  const server = createMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
}
