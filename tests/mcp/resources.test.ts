import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { OpcUaGateway, OpcUaStatus } from '../../src/opcua/gateway.js';

const config = appConfigSchema.parse({
  version: 1,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'usernamePassword', username: '${OPCUA_USERNAME}', password: '${OPCUA_PASSWORD}' },
  },
  read: {
    defaultBrowseDepth: 2,
    maxBrowseDepth: 5,
    maxReadBatchSize: 25,
    roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' }],
  },
  audit: { file: './audit.jsonl' },
  controls: {
    enabled: false,
    items: [
      {
        name: 'set_motor_speed',
        description: 'Sets motor speed.',
        nodeId: 'ns=2;s=Motor.SpeedSetpoint',
        dataType: 'Double',
        unit: 'rpm',
        min: 0,
        max: 1800,
        riskLevel: 'medium',
        riskNote: 'Changes motor speed.',
      },
    ],
  },
});

describe('MCP metadata resources', () => {
  it('exposes status while the OPC UA Server is disconnected and sanitizes errors', async () => {
    const { client, server } = await connectTestClient(config, {
      state: 'disconnected',
      connectionGeneration: 0,
      lastError: {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED opc.tcp://localhost:4840\n    at Secret.stack (internal)',
        at: '2026-07-05T00:00:00.000Z',
      },
    });

    try {
      const status = await readJsonResource(client, 'opcua://status');

      expect(status).toMatchObject({
        connection: {
          state: 'disconnected',
          lastError: { code: 'ECONNREFUSED', at: '2026-07-05T00:00:00.000Z' },
        },
        onlineValidation: { state: 'pending' },
        controls: { configured: 1, lowRisk: 0, mediumRisk: 1, enabled: false },
        audit: { healthy: true },
        configHash: 'abc123',
      });
      expect(JSON.stringify(status)).not.toContain('Secret.stack');
      expect(JSON.stringify(status)).not.toContain('readWrite');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes a redacted config summary and unexpanded Read Entry Points summary', async () => {
    const { client, server } = await connectTestClient(config, {
      state: 'disconnected',
      connectionGeneration: 0,
    });

    try {
      const configSummary = await readJsonResource(client, 'opcua://config/summary');
      const readEntryPoints = await readJsonResource(client, 'opcua://read-entry-points');

      expect(configSummary).toMatchObject({
        version: 1,
        connection: {
          endpointUrl: 'opc.tcp://localhost:4840',
          securityMode: 'None',
          securityPolicy: 'None',
          auth: { type: 'usernamePassword', username: '[redacted]', password: '[redacted]' },
        },
        read: {
          defaultBrowseDepth: 2,
          maxBrowseDepth: 5,
          maxReadBatchSize: 25,
          roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' }],
        },
        audit: { file: './audit.jsonl', maxReasonLength: 1000 },
        controls: { enabled: false, configured: 1 },
        configHash: 'abc123',
      });
      expect(configSummary).not.toHaveProperty('server');
      expect(readEntryPoints).toMatchObject({
        defaultBrowseDepth: 2,
        maxBrowseDepth: 5,
        maxReadBatchSize: 25,
        roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(config: AppConfig, status: OpcUaStatus) {
  const server = createMcpServer({
    config,
    configHash: 'abc123',
    gateway: fakeGateway(status),
    auditSink: { health: () => Promise.resolve({ healthy: true }), append: (record) => Promise.resolve({ id: record.id }) },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function readJsonResource(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (content === undefined || !('text' in content)) throw new Error(`No text content for ${uri}`);
  return JSON.parse(content.text);
}

function fakeGateway(status: OpcUaStatus): OpcUaGateway {
  return {
    status: () => Promise.resolve(status),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: () => Promise.reject(new Error('not used')),
    read: () => Promise.reject(new Error('not used')),
    readMany: () => Promise.reject(new Error('not used')),
    write: () => Promise.reject(new Error('not used')),
  };
}
