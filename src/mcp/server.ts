import type { AppConfig } from '../config/schema.js';
import type { AuditSink } from '../audit/audit-sink.js';
import type { OpcUaGateway } from '../opcua/gateway.js';

export interface McpServerDependencies {
  config: AppConfig;
  configHash: string;
  gateway: OpcUaGateway;
  auditSink: AuditSink;
}

export function startMcpServer(dependencies: McpServerDependencies): Promise<void> {
  void dependencies;
  // MCP transport wiring will be implemented after config/policy tests are in place.
  return Promise.reject(new Error('MCP server startup is not implemented yet.'));
}
