import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { NodeOpcUaGateway } from '../../src/opcua/node-opcua-gateway.js';
import type { AuditSink } from '../../src/audit/audit-sink.js';
import type { OpcUaGateway } from '../../src/opcua/gateway.js';

interface ToolTextResult {
  content: { type: 'text'; text: string }[];
}

const endpointUrl = process.env['OPCUA_TEST_ENDPOINT'];
const readNodeId = process.env['OPCUA_TEST_READ_NODE_ID'];
const enableWrites = process.env['OPCUA_TEST_ENABLE_WRITES'] === 'true';
const writeNodeId = process.env['OPCUA_TEST_WRITE_NODE_ID'];
const writeValue = process.env['OPCUA_TEST_WRITE_VALUE'];
const writeDataType = process.env['OPCUA_TEST_WRITE_DATA_TYPE'] ?? 'String';
const hasEndpoint = endpointUrl !== undefined && endpointUrl.length > 0;
const hasReadPrerequisites = hasEndpoint && readNodeId !== undefined && readNodeId.length > 0;
const hasWritePrerequisites =
  hasEndpoint &&
  enableWrites &&
  writeNodeId !== undefined &&
  writeNodeId.length > 0 &&
  writeValue !== undefined;

const describeWithEndpoint = hasEndpoint ? describe : describe.skip;
const itWithReadNode = hasReadPrerequisites ? it : it.skip;
const itWithWriteNode = hasWritePrerequisites ? it : it.skip;

describeWithEndpoint('real OPC UA integration', () => {
  it('connects and reports connected status through the MCP Server', async () => {
    const config = buildConfig();
    const gateway = new NodeOpcUaGateway({ connection: config.connection });
    await gateway.connect();
    try {
      await waitForConnected(gateway);
      const { client, server } = await connectTestClient(config, gateway);
      try {
        await expect(readJsonResource(client, 'opcua://status')).resolves.toMatchObject({
          connection: { state: 'connected' },
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await gateway.close();
    }
  });

  itWithReadNode('reads a configured real OPC UA Node through the MCP Server', async () => {
    const config = buildConfig({ readNodeId: requireEnv('OPCUA_TEST_READ_NODE_ID') });
    const gateway = new NodeOpcUaGateway({ connection: config.connection });
    await gateway.connect();
    try {
      await waitForConnected(gateway);
      const { client, server } = await connectTestClient(config, gateway);
      try {
        const result = await callJsonTool(client, 'read_node', { label: 'integration_read_node' });
        expect(result).toMatchObject({ ok: true, nodeId: requireEnv('OPCUA_TEST_READ_NODE_ID') });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await gateway.close();
    }
  });

  itWithWriteNode('performs one explicitly enabled safe Semantic Control write', async () => {
    const writeConfigOptions: BuildConfigOptions = {
      writeNodeId: requireEnv('OPCUA_TEST_WRITE_NODE_ID'),
      writeValue: requireEnv('OPCUA_TEST_WRITE_VALUE'),
      writeDataType,
    };
    if (readNodeId !== undefined) writeConfigOptions.readNodeId = readNodeId;
    const config = buildConfig(writeConfigOptions);
    const gateway = new NodeOpcUaGateway({ connection: config.connection });
    await gateway.connect();
    try {
      await waitForConnected(gateway);
      const { client, server } = await connectTestClient(config, gateway);
      try {
        const result = await callJsonTool(client, 'write_control', {
          controlName: 'integration_safe_write',
          value: normalizeWriteInput(requireEnv('OPCUA_TEST_WRITE_VALUE'), writeDataType),
          reason: 'Operator-approved real OPC UA integration test write.',
        });
        expect(result).toMatchObject({ ok: true, controlName: 'integration_safe_write' });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await gateway.close();
    }
  });
});

interface BuildConfigOptions {
  readNodeId?: string;
  writeNodeId?: string;
  writeValue?: string;
  writeDataType?: string;
}

function buildConfig(options: BuildConfigOptions = {}): AppConfig {
  return appConfigSchema.parse({
    version: 1,
    connection: {
      endpointUrl: requireEnv('OPCUA_TEST_ENDPOINT'),
      securityMode: process.env['OPCUA_TEST_SECURITY_MODE'] ?? 'None',
      securityPolicy: process.env['OPCUA_TEST_SECURITY_POLICY'] ?? 'None',
      auth: buildAuth(),
    },
    read: {
      roots:
        options.readNodeId !== undefined
          ? [{ nodeId: options.readNodeId, label: 'integration_read_node' }]
          : [],
    },
    audit: { file: './integration-audit.jsonl' },
    controls:
      options.writeNodeId !== undefined && options.writeValue !== undefined
        ? { items: [buildWriteControl(options.writeNodeId, options.writeValue, options.writeDataType ?? 'String')] }
        : { items: [] },
  });
}

function buildAuth(): AppConfig['connection']['auth'] {
  if (process.env['OPCUA_TEST_USERNAME'] === undefined && process.env['OPCUA_TEST_PASSWORD'] === undefined) {
    return { type: 'anonymous' };
  }
  if (process.env['OPCUA_TEST_USERNAME'] === undefined || process.env['OPCUA_TEST_PASSWORD'] === undefined) {
    throw new Error('Set both OPCUA_TEST_USERNAME and OPCUA_TEST_PASSWORD for username/password auth.');
  }
  return { type: 'usernamePassword', username: '${OPCUA_TEST_USERNAME}', password: '${OPCUA_TEST_PASSWORD}' };
}

function buildWriteControl(nodeId: string, rawValue: string, dataType: string): Record<string, unknown> {
  const base = {
    name: 'integration_safe_write',
    description: 'Operator-approved safe integration test write.',
    nodeId,
    riskLevel: 'low',
    riskNote: 'Only use with simulator, test, or otherwise safe Nodes approved by an Operator.',
  };
  if (dataType === 'Boolean') {
    return { ...base, dataType: 'Boolean', falseLabel: 'false', trueLabel: 'true' };
  }
  if (['SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double'].includes(dataType)) {
    const numericValue = Number(rawValue);
    const spread = Math.max(Math.abs(numericValue), 1);
    return { ...base, dataType, unit: 'integration_test_unit', min: numericValue - spread, max: numericValue + spread };
  }
  return { ...base, dataType: 'String', allowedValues: [{ label: 'test_value', value: rawValue }] };
}

function normalizeWriteInput(rawValue: string, dataType: string): unknown {
  if (dataType === 'Boolean') return rawValue === 'true' ? 'true' : 'false';
  if (['SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double'].includes(dataType)) {
    return Number(rawValue);
  }
  return 'test_value';
}

async function connectTestClient(config: AppConfig, gateway: OpcUaGateway) {
  const server = createMcpServer({ config, configHash: 'integration', gateway, auditSink: healthyAuditSink() });
  const client = new Client({ name: 'real-opcua-integration-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function waitForConnected(gateway: OpcUaGateway): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await gateway.status();
    if (status.state === 'connected') return;
    if (status.lastError !== undefined) throw new Error(status.lastError.message);
    await sleep(50);
  }
  throw new Error('Timed out waiting for OPC UA integration test connection.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as ToolTextResult;
  const content = result.content[0];
  if (content === undefined) throw new Error(`No text content for ${name}`);
  return JSON.parse(content.text) as unknown;
}

async function readJsonResource(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
    throw new Error(`No text content for ${uri}`);
  }
  return JSON.parse(content.text) as unknown;
}

function healthyAuditSink(): AuditSink {
  return {
    health: () => Promise.resolve({ healthy: true }),
    append: (record) => Promise.resolve({ id: record.id }),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
