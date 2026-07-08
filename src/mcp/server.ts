import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import { appendControlAuditRecord, requireHealthyAudit } from '../audit/control-audit.js';
import type { ControlItem } from '../config/schema.js';
import { normalizeControlValue } from '../control/value-normalization.js';
import { getReadEntryPoints, resolveReadEntryPointLabel } from '../policy/read-entry-points.js';
import { requireConnectedOpcUa } from './live-opcua-preflight.js';
import type { BrowseNodeResult, OpcUaGateway, ReadValueResult } from '../opcua/gateway.js';
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
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({ name: 'opcua-mcp-server', version: '0.1.0' });
  const writeState: WriteControlState = {
    lastWriteAtByControlName: new Map(),
    confirmationTokens: new Map(),
  };

  server.registerResource(
    'status',
    'opcua://status',
    {
      title: 'OPC UA MCP Server status',
      description: 'Safe operational status for the MCP Server and OPC UA connection.',
      mimeType: 'application/json',
    },
    async () => jsonResource('opcua://status', await buildStatusResource(dependencies)),
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

  if ((dependencies.config.controls?.items.length ?? 0) > 0) {
    server.registerTool(
      'list_controls',
      {
        title: 'List Semantic Controls',
        description: 'List Operator-defined Semantic Controls and their current availability.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => toolJson(await listControlsTool(dependencies)),
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
        toolJson(await prepareControlTool(dependencies, writeState, { controlName, value, reason })),
    );

    server.registerTool(
      'commit_control',
      {
        title: 'Commit medium-risk Semantic Control',
        description: 'Commit a prepared medium-risk Semantic Control Operation by token.',
        inputSchema: { token: z.string().min(1) },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ token }) => toolJson(await commitControlTool(dependencies, writeState, { token })),
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
        return toolJson(await writeControlTool(dependencies, writeState, args));
      },
    );
  }

  server.registerTool(
    'browse_node',
    {
      title: 'Browse OPC UA Node',
      description:
        'Browse OPC UA structure from a NodeId or configured Read Entry Point label. With no identifier, returns configured Read Entry Points.',
      inputSchema: {
        nodeId: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        depth: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nodeId, label, depth }) => {
      const args: BrowseNodeArgs = {};
      if (nodeId !== undefined) args.nodeId = nodeId;
      if (label !== undefined) args.label = label;
      if (depth !== undefined) args.depth = depth;
      const body = await browseNodeTool(dependencies, args);
      return toolJson(body);
    },
  );

  server.registerTool(
    'read_node',
    {
      title: 'Read OPC UA Node',
      description: 'Read one OPC UA Node by NodeId or configured label.',
      inputSchema: {
        nodeId: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nodeId, label }) => {
      const args: ReadNodeIdentifier = {};
      if (nodeId !== undefined) args.nodeId = nodeId;
      if (label !== undefined) args.label = label;
      const body = await readNodeTool(dependencies, args);
      return toolJson(body);
    },
  );

  server.registerTool(
    'read_nodes',
    {
      title: 'Read OPC UA Nodes',
      description: 'Read a bounded batch of OPC UA Nodes by NodeId or configured label.',
      inputSchema: {
        identifiers: z
          .array(
            z.object({ nodeId: z.string().min(1).optional(), label: z.string().min(1).optional() }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ identifiers }) => {
      const readIdentifiers = identifiers.map((identifier) => {
        const readIdentifier: ReadNodeIdentifier = {};
        if (identifier.nodeId !== undefined) readIdentifier.nodeId = identifier.nodeId;
        if (identifier.label !== undefined) readIdentifier.label = identifier.label;
        return readIdentifier;
      });
      const body = await readNodesTool(dependencies, { identifiers: readIdentifiers });
      return toolJson(body);
    },
  );

  return server;
}

interface BrowseNodeArgs {
  nodeId?: string;
  label?: string;
  depth?: number;
}

interface ReadNodeIdentifier {
  nodeId?: string;
  label?: string;
}

interface ReadNodesArgs {
  identifiers: ReadNodeIdentifier[];
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

interface ResolvedReadIdentifier {
  nodeId: string;
  label?: string;
  control?: ControlItem;
}

interface ReadResolutionError extends Record<string, unknown> {
  ok: false;
  code: string;
  message: string;
}

type ReadResolution = ResolvedReadIdentifier | ReadResolutionError;

async function listControlsTool(
  dependencies: McpServerDependencies,
): Promise<Record<string, unknown>> {
  const controls = dependencies.config.controls?.items ?? [];
  const defaultCooldownMs = dependencies.config.controls?.defaults.cooldownMs ?? 0;
  const controlsEnabled = dependencies.config.controls?.enabled ?? false;
  const status = await dependencies.gateway.status();
  const auditHealth = await dependencies.auditSink.health();
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
      };
    }),
  };
}

async function prepareControlTool(
  dependencies: McpServerDependencies,
  state: WriteControlState,
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
      result: verification.ok ? 'succeeded' : 'verification_failed',
      opcuaStatus: write.opcuaStatus,
    },
  });
  state.confirmationTokens.delete(args.token);
  state.lastWriteAtByControlName.set(control.name, Date.now());

  return {
    ok: verification.ok,
    ...(verification.ok ? {} : { code: 'write_accepted_verification_failed' }),
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
      result: verification.ok ? 'succeeded' : 'verification_failed',
      opcuaStatus: write.opcuaStatus,
    },
  });
  state.lastWriteAtByControlName.set(control.name, Date.now());

  return {
    ok: verification.ok,
    ...(verification.ok ? {} : { code: 'write_accepted_verification_failed' }),
    controlName: control.name,
    nodeId: control.nodeId,
    requestedValue: normalized.value,
    rawRequestedValue: normalized.rawValue,
    riskLevel: control.riskLevel,
    opcuaStatus: write.opcuaStatus,
    verification,
  };
}

async function verifyControlWrite(
  gateway: OpcUaGateway,
  control: ControlItem,
  rawRequestedValue: unknown,
): Promise<Record<string, unknown> & { ok: boolean }> {
  const read = await gateway.read(control.nodeId);
  const normalized = normalizeReadValue(control, read.value);
  return {
    ok: read.value === rawRequestedValue,
    value: normalized.value,
    ...(normalized.rawValueIncluded ? { rawValue: normalized.rawValue } : {}),
    ...(read.opcuaStatus !== undefined ? { opcuaStatus: read.opcuaStatus } : {}),
  };
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

async function browseNodeTool(
  dependencies: McpServerDependencies,
  args: BrowseNodeArgs,
): Promise<Record<string, unknown>> {
  if (args.nodeId === undefined && args.label === undefined) {
    return { ok: true, mode: 'read_entry_points', roots: getReadEntryPoints(dependencies.config) };
  }

  if (args.nodeId !== undefined && args.label !== undefined) {
    return {
      ok: false,
      code: 'ambiguous_identifier',
      message: 'Provide either nodeId or label, not both.',
    };
  }

  if (args.label !== undefined) {
    const nodeId = resolveReadEntryPointLabel(dependencies.config, args.label);
    if (nodeId === undefined)
      return {
        ok: false,
        code: 'unknown_read_entry_point',
        message: `Unknown Read Entry Point label: ${args.label}`,
      };
    const depth = resolveBrowseDepth(dependencies.config, args.depth);
    return browseFromNodeId(dependencies.gateway, nodeId, depth, { nodeId, label: args.label });
  }

  const nodeId = args.nodeId;
  if (nodeId !== undefined) {
    const depth = resolveBrowseDepth(dependencies.config, args.depth);
    return browseFromNodeId(dependencies.gateway, nodeId, depth, { nodeId });
  }

  return { ok: false, code: 'not_implemented' };
}

async function browseFromNodeId(
  gateway: OpcUaGateway,
  nodeId: string,
  depth: number,
  start: Record<string, string>,
): Promise<Record<string, unknown>> {
  try {
    const preflight = await requireConnectedOpcUa(gateway);
    if (!preflight.ok) return preflight.response;

    const nodes = sanitizeBrowseResults(await gateway.browse(nodeId, depth));
    return { ok: true, mode: 'browse', start, depth, nodes };
  } catch (error) {
    return { ok: false, ...sanitizeToolError(error, 'opcua_browse_failed') };
  }
}

async function readNodeTool(
  dependencies: McpServerDependencies,
  identifier: ReadNodeIdentifier,
): Promise<Record<string, unknown>> {
  const results = await readNodesTool(dependencies, { identifiers: [identifier] });
  const maybeResults = results['results'];
  if (Array.isArray(maybeResults)) {
    const result = maybeResults[0] as unknown;
    if (isRecord(result) && result['ok'] === false) return result;
    return { ok: results['ok'], result };
  }
  return results;
}

async function readNodesTool(
  dependencies: McpServerDependencies,
  args: ReadNodesArgs,
): Promise<Record<string, unknown>> {
  if (args.identifiers.length > dependencies.config.read.maxReadBatchSize) {
    return {
      ok: false,
      code: 'read_batch_too_large',
      message: `Batch size ${String(args.identifiers.length)} exceeds configured maximum ${String(dependencies.config.read.maxReadBatchSize)}.`,
    };
  }

  const resolved = args.identifiers.map((identifier) =>
    resolveReadIdentifier(dependencies.config, identifier),
  );
  const hasResolutionError = resolved.some(isReadResolutionError);
  const hasLiveRead = resolved.some((identifier) => !isReadResolutionError(identifier));
  let preflightError: Record<string, unknown> | undefined;
  if (hasLiveRead) {
    const preflight = await requireConnectedOpcUa(dependencies.gateway);
    if (!preflight.ok) {
      if (!hasResolutionError) return preflight.response;
      preflightError = preflight.response;
    }
  }

  const results = await Promise.all(
    resolved.map(async (identifier) => {
      if (isReadResolutionError(identifier)) return identifier;
      if (preflightError !== undefined) return buildReadPreflightError(identifier, preflightError);
      return readResolvedNode(dependencies.gateway, identifier);
    }),
  );

  return { ok: results.every((result) => result['ok'] === true), results };
}

function resolveReadIdentifier(config: AppConfig, identifier: ReadNodeIdentifier): ReadResolution {
  if (identifier.nodeId !== undefined && identifier.label !== undefined) {
    return {
      ok: false,
      code: 'ambiguous_identifier',
      message: 'Provide either nodeId or label, not both.',
    };
  }
  if (identifier.nodeId === undefined && identifier.label === undefined) {
    return { ok: false, code: 'missing_identifier', message: 'Provide nodeId or label.' };
  }

  if (identifier.label !== undefined) {
    const labelled = findConfiguredReadLabel(config, identifier.label);
    if (labelled === undefined) {
      return {
        ok: false,
        label: identifier.label,
        code: 'unknown_read_label',
        message: `Unknown read label: ${identifier.label}`,
      };
    }
    return labelled;
  }

  const nodeId = identifier.nodeId;
  if (nodeId === undefined) {
    return { ok: false, code: 'missing_identifier', message: 'Provide nodeId or label.' };
  }
  const metadata = findReadMetadataByNodeId(config, nodeId);
  return metadata ?? { nodeId };
}

async function readResolvedNode(
  gateway: OpcUaGateway,
  identifier: ResolvedReadIdentifier,
): Promise<Record<string, unknown>> {
  try {
    const read = await gateway.read(identifier.nodeId);
    return buildReadSuccess(read, identifier);
  } catch (error) {
    return {
      ok: false,
      nodeId: identifier.nodeId,
      ...(identifier.label !== undefined ? { label: identifier.label } : {}),
      ...sanitizeToolError(error, 'opcua_read_failed'),
    };
  }
}

function buildReadPreflightError(
  identifier: ResolvedReadIdentifier,
  preflightError: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...preflightError,
    nodeId: identifier.nodeId,
    ...(identifier.label !== undefined ? { label: identifier.label } : {}),
  };
}

function buildReadSuccess(
  read: ReadValueResult,
  identifier: ResolvedReadIdentifier,
): Record<string, unknown> {
  const normalized = normalizeReadValue(identifier.control, read.value);
  return {
    ok: true,
    nodeId: read.nodeId,
    ...(identifier.label !== undefined ? { label: identifier.label } : {}),
    value: normalized.value,
    ...(normalized.rawValueIncluded ? { rawValue: normalized.rawValue } : {}),
    ...(read.dataType !== undefined ? { dataType: read.dataType } : {}),
    ...(identifier.control !== undefined && 'unit' in identifier.control
      ? { unit: identifier.control.unit }
      : {}),
    ...(read.opcuaStatus !== undefined ? { opcuaStatus: read.opcuaStatus } : {}),
    ...(read.sourceTimestamp !== undefined ? { sourceTimestamp: read.sourceTimestamp } : {}),
    ...(read.serverTimestamp !== undefined ? { serverTimestamp: read.serverTimestamp } : {}),
  };
}

function resolveBrowseDepth(config: AppConfig, requestedDepth: number | undefined): number {
  return Math.min(requestedDepth ?? config.read.defaultBrowseDepth, config.read.maxBrowseDepth);
}

function findConfiguredReadLabel(
  config: AppConfig,
  label: string,
): ResolvedReadIdentifier | undefined {
  const root = config.read.roots.find((candidate) => candidate.label === label);
  if (root !== undefined) return { nodeId: root.nodeId, label };

  const control = config.controls?.items.find((candidate) => candidate.name === label);
  if (control !== undefined) return { nodeId: control.nodeId, label: control.name, control };
  return undefined;
}

function findReadMetadataByNodeId(
  config: AppConfig,
  nodeId: string,
): ResolvedReadIdentifier | undefined {
  const root = config.read.roots.find((candidate) => candidate.nodeId === nodeId);
  if (root?.label !== undefined) return { nodeId, label: root.label };

  const control = config.controls?.items.find((candidate) => candidate.nodeId === nodeId);
  if (control !== undefined) return { nodeId, label: control.name, control };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReadResolutionError(value: ReadResolution): value is ReadResolutionError {
  return 'ok' in value;
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

function toolJson(body: Record<string, unknown>): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
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

function sanitizeBrowseResults(results: BrowseNodeResult[]): BrowseNodeResult[] {
  return results.map((result) => {
    const sanitized: BrowseNodeResult = { nodeId: result.nodeId };
    if (result.browseName !== undefined) sanitized.browseName = result.browseName;
    if (result.displayName !== undefined) sanitized.displayName = result.displayName;
    if (result.nodeClass !== undefined) sanitized.nodeClass = result.nodeClass;
    if (result.dataType !== undefined) sanitized.dataType = result.dataType;
    if (result.readable !== undefined) sanitized.readable = result.readable;
    if (result.writable !== undefined) sanitized.writable = result.writable;
    if (result.callable !== undefined) sanitized.callable = result.callable;
    return sanitized;
  });
}

export async function startMcpServer(dependencies: McpServerDependencies): Promise<void> {
  void dependencies.gateway.connect();
  const server = createMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
}
