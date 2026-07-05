import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import type { OpcUaGateway } from '../opcua/gateway.js';
import {
  buildConfigSummaryResource,
  buildReadScopeResource,
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
    'read_scope',
    'opcua://read-scope',
    {
      title: 'OPC UA MCP Server Read Scope',
      description: 'Configured Read Scope roots, explicit Nodes, and exclusions without live browsing.',
      mimeType: 'application/json',
    },
    () => jsonResource('opcua://read-scope', buildReadScopeResource(dependencies.config)),
  );

  return server;
}

export async function startMcpServer(dependencies: McpServerDependencies): Promise<void> {
  const server = createMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
}
