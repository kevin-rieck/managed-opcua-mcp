import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import type { ControlItem } from '../config/schema.js';
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
  return { code, message: message.split('\n')[0]?.slice(0, 500) ?? 'OPC UA browse failed.' };
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
