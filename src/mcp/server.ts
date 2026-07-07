import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import { getReadEntryPoints, resolveReadEntryPointLabel } from '../policy/read-entry-points.js';
import { requireConnectedOpcUa } from './live-opcua-preflight.js';
import type { BrowseNodeResult, OpcUaGateway } from '../opcua/gateway.js';
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
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    },
  );

  return server;
}

interface BrowseNodeArgs {
  nodeId?: string;
  label?: string;
  depth?: number;
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

function resolveBrowseDepth(config: AppConfig, requestedDepth: number | undefined): number {
  return Math.min(requestedDepth ?? config.read.defaultBrowseDepth, config.read.maxBrowseDepth);
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
