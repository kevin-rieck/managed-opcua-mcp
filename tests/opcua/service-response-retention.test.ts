import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { NodeOpcUaGateway, type OpcUaSessionLike } from '../../src/opcua/node-opcua-gateway.js';

const require = createRequire(import.meta.url);
const { ClientSessionImpl } = require('node-opcua-client/dist/private/client_session_impl.js') as {
  ClientSessionImpl: new (client: unknown) => OpcUaSessionLike;
};
const { ReadResponse } = require('node-opcua-service-read') as {
  ReadResponse: new (options: unknown) => unknown;
};
const { BrowseResponse } = require('node-opcua-service-browse') as {
  BrowseResponse: new (options: unknown) => unknown;
};
const { StatusCodes } = require('node-opcua-status-code') as {
  StatusCodes: Record<string, { value: number; name: string }>;
};

interface Request {
  constructor: { name: string };
  nodesToRead?: { nodeId: { value: number } }[];
}
const config = appConfigSchema.parse({
  version: 2,
  connection: {
    endpointUrl: 'opc.tcp://example.invalid:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: { roots: [] },
  audit: { file: './unused.jsonl' },
});

describe('installed SDK read/browse service responses', () => {
  it('preserves ordinary failed responses through gateway and MCP while isolating batch reads', async () => {
    const transport = vi.fn(
      (request: Request, callback: (error: null, response: unknown) => void) => {
        if (request.constructor.name === 'BrowseRequest') {
          callback(
            null,
            new BrowseResponse({
              responseHeader: { serviceResult: StatusCodes['BadNotSupported'] },
            }),
          );
        } else if (request.nodesToRead?.[0]?.nodeId.value === 2) {
          callback(
            null,
            new ReadResponse({
              results: [{ value: { dataType: 11, value: 12.5 }, statusCode: StatusCodes['Good'] }],
            }),
          );
        } else {
          callback(
            null,
            new ReadResponse({
              responseHeader: { serviceResult: StatusCodes['BadUserAccessDenied'] },
            }),
          );
        }
      },
    );
    const session = new ClientSessionImpl({
      _secureChannel: { isOpened: () => true },
      isReconnecting: false,
      performMessageTransaction: transport,
    });
    session.close = () => Promise.resolve();
    const gateway = new NodeOpcUaGateway({
      connection: config.connection,
      clientFactory: () => ({
        connect: () => Promise.resolve(),
        createSession: () => Promise.resolve(session),
        disconnect: () => Promise.resolve(),
      }),
    });
    await gateway.connect();
    await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'));
    const readStatus = { value: 0x801f0000, hex: '0x801f0000', name: 'BadUserAccessDenied' };
    const browseStatus = { value: 0x803d0000, hex: '0x803d0000', name: 'BadNotSupported' };
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
    try {
      await expect(gateway.read('i=1')).rejects.toMatchObject({ statusCode: readStatus });
      await expect(gateway.browse('i=1', 1)).rejects.toMatchObject({ statusCode: browseStatus });
      await expect(gateway.getNodeMetadata('i=1')).resolves.toMatchObject({
        attributeStatusCodes: { nodeId: readStatus, browse: browseStatus },
      });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const batch = await callJsonTool(client, 'read_nodes', {
        identifiers: [{ nodeId: 'i=1' }, { nodeId: 'i=2' }],
      });
      expect(batch).toMatchObject({
        ok: false,
        results: [
          { ok: false, statusCode: readStatus },
          { ok: true, value: 12.5 },
        ],
      });
      const browse = await callJsonTool(client, 'browse_node', { nodeId: 'i=1', depth: 1 });
      expect(browse).toMatchObject({ ok: false, statusCode: browseStatus });
    } finally {
      await client.close();
      await server.close();
      await gateway.close();
    }
  }, 30000);
});

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: 'text'; text: string }[];
  };
  if (!result.content[0]) throw new Error('Missing tool result');
  return JSON.parse(result.content[0].text) as unknown;
}
