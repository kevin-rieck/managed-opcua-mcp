import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { OpcUaGateway } from '../../src/opcua/gateway.js';
import { fakeInspection } from './inspection-fixture.js';

const config = appConfigSchema.parse({
  version: 1,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
  audit: { file: './audit.jsonl' },
});

describe('MCP inspection contract', () => {
  it('exposes only the native read-only inspection tools and resources', async () => {
    const { client, server } = await connectTestClient(config);

    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'browse_node',
        'inspect_node',
        'inspect_nodes',
        'read_node',
        'read_nodes',
      ]);
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
        'opcua://status',
        'opcua://config/summary',
        'opcua://read-entry-points',
        'opcua://model-context',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(config: AppConfig) {
  const server = createMcpServer({
    config,
    configHash: 'contract-hash',
    gateway: fakeGateway(),
    auditSink: {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => Promise.resolve({ id: record.id }),
    },
    inspection: fakeInspection(),
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
