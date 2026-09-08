import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { OpcUaGateway } from '../../src/opcua/gateway.js';
import type { OpcUaInspectionModule } from '../../src/opcua/inspection-contracts.js';
import { fakeInspection } from './inspection-fixture.js';

const config = appConfigSchema.parse({
  version: 1,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: {
    roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
  },
  audit: { file: './audit.jsonl' },
});

describe('native MCP inspection surface', () => {
  it('registers inspect singleton and batch tools', async () => {
    const inspection = fakeInspection();
    const { client, server } = await connectTestClient(config, inspection);

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual([
        'browse_node',
        'inspect_node',
        'inspect_nodes',
        'read_node',
        'read_nodes',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('routes native singleton and batch reads without control normalization', async () => {
    const inspection = fakeInspection();
    const { client, server } = await connectTestClient(config, inspection);
    const read = inspection.read;

    try {
      await callJsonTool(client, 'read_node', { nodeId: 'ns=2;s=Machine.Value' });
      expect(read).toHaveBeenCalledWith({ selector: { nodeId: 'ns=2;s=Machine.Value' } });

      await callJsonTool(client, 'read_nodes', {
        selectors: [{ label: 'machine' }, { nodeId: 'ns=2;s=Machine.Value' }],
      });
      expect(read).toHaveBeenCalledWith({
        selectors: [{ label: 'machine' }, { nodeId: 'ns=2;s=Machine.Value' }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(config: AppConfig, inspection: OpcUaInspectionModule) {
  const server = createMcpServer({
    config,
    configHash: 'abc123',
    gateway: fakeGateway(),
    auditSink: {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => Promise.resolve({ id: record.id }),
    },
    inspection,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function fakeGateway(): OpcUaGateway {
  return {
    status: () => Promise.resolve({ state: 'connected', connectionGeneration: 1 }),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: () => Promise.resolve([]),
    read: () => Promise.reject(new Error('not used')),
    readMany: () => Promise.resolve([]),
    write: () => Promise.reject(new Error('not used')),
  };
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
  };
  const content = result.content[0];
  if (content === undefined || !('text' in content)) throw new Error(`No text content for ${name}`);
  return JSON.parse(content.text);
}
