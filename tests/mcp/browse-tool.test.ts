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
  read: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
  audit: { file: './audit.jsonl' },
});

describe('browse_node MCP tool', () => {
  it('requires an explicit NodeId or Read Entry Point label', async () => {
    const inspection = fakeInspection();
    const { client, server } = await connectTestClient(config, inspection);
    const browse = inspection.browse;

    try {
      await expect(callJsonTool(client, 'browse_node', {})).resolves.toEqual({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Provide a NodeId or Read Entry Point label.',
        },
      });
      expect(browse).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('routes native browse queries and opaque continuations to the inspection module', async () => {
    const inspection = fakeInspection();
    const { client, server } = await connectTestClient(config, inspection);
    const browse = inspection.browse;

    try {
      await callJsonTool(client, 'browse_node', {
        label: 'machine',
        direction: 'inverse',
        referenceScope: 'all',
        depth: 2,
        pageSize: 3,
      });
      expect(browse).toHaveBeenCalledWith({
        selector: { label: 'machine' },
        direction: 'inverse',
        referenceScope: 'all',
        depth: 2,
        pageSize: 3,
      });

      await callJsonTool(client, 'browse_node', { continuation: 'opaque-token' });
      expect(browse).toHaveBeenCalledWith({ continuation: 'opaque-token' });
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
