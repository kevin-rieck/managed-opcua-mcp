import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import type { OpcUaGateway } from '../opcua/gateway.js';
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
    () => jsonResource('opcua://config/summary', buildConfigSummaryResource(dependencies.config, dependencies.configHash)),
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
      jsonResource(
        'opcua://read-entry-points',
        buildReadEntryPointsResource(dependencies.config),
      ),
  );

  return server;
}

export async function startMcpServer(dependencies: McpServerDependencies): Promise<void> {
  void dependencies.gateway.connect();
  const server = createMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
}
