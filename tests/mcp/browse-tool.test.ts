import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { BrowseNodeResult, OpcUaGateway, OpcUaStatus } from '../../src/opcua/gateway.js';

interface ToolTextResult {
  content: { type: 'text'; text: string }[];
}

const config = appConfigSchema.parse({
  version: 1,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: {
    defaultBrowseDepth: 2,
    maxBrowseDepth: 5,
    roots: [
      { nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' },
      { nodeId: 'ns=2;s=Line', label: 'line' },
    ],
  },
  audit: { file: './audit.jsonl' },
});

describe('browse_node MCP tool', () => {
  it('returns configured Read Entry Points when called without an identifier', async () => {
    const gateway = fakeGateway();
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'browse_node', {});

      expect(result).toEqual({
        ok: true,
        mode: 'read_entry_points',
        roots: [
          { nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' },
          { nodeId: 'ns=2;s=Line', label: 'line' },
        ],
      });
      expect(gateway.browse).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('browses from a configured Read Entry Point label using the default depth', async () => {
    const gateway = fakeGateway([
      {
        nodeId: 'ns=2;s=Machine.Motor',
        browseName: '2:Motor',
        displayName: 'Motor',
        nodeClass: 'Object',
        readable: false,
        writable: false,
        callable: false,
      },
    ]);
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'browse_node', { label: 'machine' });

      expect(gateway.browse).toHaveBeenCalledWith('ns=2;s=Machine', 2);
      expect(result).toEqual({
        ok: true,
        mode: 'browse',
        start: { nodeId: 'ns=2;s=Machine', label: 'machine' },
        depth: 2,
        nodes: [
          {
            nodeId: 'ns=2;s=Machine.Motor',
            browseName: '2:Motor',
            displayName: 'Motor',
            nodeClass: 'Object',
            readable: false,
            writable: false,
            callable: false,
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('value');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('browses a direct NodeId and caps requested depth to the configured maximum', async () => {
    const gateway = fakeGateway([
      { nodeId: 'ns=2;s=Any.Child', displayName: 'Child', dataType: 'Double', readable: true },
    ]);
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'browse_node', { nodeId: 'ns=2;s=Any', depth: 99 });

      expect(gateway.browse).toHaveBeenCalledWith('ns=2;s=Any', 5);
      expect(result).toMatchObject({
        ok: true,
        mode: 'browse',
        start: { nodeId: 'ns=2;s=Any' },
        depth: 5,
        nodes: [
          { nodeId: 'ns=2;s=Any.Child', displayName: 'Child', dataType: 'Double', readable: true },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a structured not-connected response without browsing live Nodes', async () => {
    const gateway = fakeGateway([], { state: 'connecting', connectionGeneration: 0 });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      await expect(callJsonTool(client, 'browse_node', { label: 'machine' })).resolves.toMatchObject({
        ok: false,
        code: 'opcua_not_connected',
        connection: { state: 'connecting', connectionGeneration: 0 },
      });
      expect(gateway.browse).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns structured rejections for invalid labels and OPC UA browse failures', async () => {
    const gateway = fakeGateway();
    gateway.browse.mockRejectedValueOnce(
      Object.assign(new Error('BadUserAccessDenied\nsecret stack'), {
        code: 'BadUserAccessDenied',
      }),
    );
    const { client, server } = await connectTestClient(config, gateway);

    try {
      await expect(
        callJsonTool(client, 'browse_node', { nodeId: 'ns=2;s=Any', label: 'machine' }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'ambiguous_identifier',
      });
      await expect(
        callJsonTool(client, 'browse_node', { label: 'unknown' }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'unknown_read_entry_point',
      });
      await expect(
        callJsonTool(client, 'browse_node', { nodeId: 'ns=2;s=Denied' }),
      ).resolves.toEqual({
        ok: false,
        code: 'BadUserAccessDenied',
        message: 'BadUserAccessDenied',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(config: AppConfig, gateway: OpcUaGateway) {
  const server = createMcpServer({
    config,
    configHash: 'abc123',
    gateway,
    auditSink: {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => Promise.resolve({ id: record.id }),
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as ToolTextResult;
  const content = result.content[0];
  if (content === undefined) throw new Error(`No text content for ${name}`);
  return JSON.parse(content.text);
}

function fakeGateway(
  results: BrowseNodeResult[] = [],
  status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 },
): OpcUaGateway & { browse: ReturnType<typeof vi.fn> } {
  return {
    status: () => Promise.resolve(status),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: vi.fn(() => Promise.resolve(results)),
    read: () => Promise.reject(new Error('not used')),
    readMany: () => Promise.reject(new Error('not used')),
    write: () => Promise.reject(new Error('not used')),
  };
}
