import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { getOnlineValidation } from '../../src/mcp/online-validation.js';
import type { AuditSink } from '../../src/audit/audit-sink.js';
import type {
  BrowseNodeResult,
  NodeMetadataResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
} from '../../src/opcua/gateway.js';

const config = appConfigSchema.parse({
  version: 2,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
  audit: { file: './audit.jsonl' },
});

describe('online validation', () => {
  it('uses numeric metadata status when a name disagrees', async () => {
    const bad = { value: 0x801f0000, hex: '0x801f0000', name: 'Good' };
    const gateway = fakeGateway({
      'ns=2;s=Machine': {
        exists: false,
        attributeStatuses: { nodeId: 'Good' },
        attributeStatusCodes: { nodeId: bad },
      },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        attributeStatuses: { dataType: 'Good' },
        attributeStatusCodes: { dataType: bad },
      },
    });
    const result = await getOnlineValidation(config, gateway, {});
    expect(result).toMatchObject({
      state: 'invalid',
      readRoots: [{ code: 'read_root_unavailable' }],
    });
  });
  it('reports pending validation while the OPC UA Server is unavailable', async () => {
    const gateway = fakeGateway({}, { state: 'reconnecting', connectionGeneration: 4 });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const status = await readJsonResource(client, 'opcua://status');
      expect(status).toMatchObject({
        onlineValidation: {
          state: 'pending',
          reasons: [{ code: 'online_validation_pending' }],
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('revalidates roots only after the connection generation changes', async () => {
    let generation = 1;
    const metadata: Record<string, NodeMetadataResult> = {
      'ns=2;s=Machine': { exists: true, browseable: false },
    };
    const gateway = fakeGateway(metadata, undefined, () => ({
      state: 'connected',
      connectionGeneration: generation,
    }));
    const cache = {};
    expect(await getOnlineValidation(config, gateway, cache)).toMatchObject({
      state: 'invalid',
      readRoots: [{ code: 'read_root_not_browseable' }],
    });
    metadata['ns=2;s=Machine'] = { exists: true, browseable: true };
    expect(await getOnlineValidation(config, gateway, cache)).toMatchObject({ state: 'invalid' });
    generation++;
    expect(await getOnlineValidation(config, gateway, cache)).toMatchObject({
      state: 'valid',
      reasons: [],
    });
  });
});

async function connectTestClient(config: AppConfig, gateway: OpcUaGateway) {
  const server = createMcpServer({
    config,
    configHash: 'abc123',
    gateway,
    auditSink: healthyAuditSink(),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function readJsonResource(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
    throw new Error(`No text content for ${uri}`);
  }
  return JSON.parse(content.text);
}

function fakeGateway(
  metadata: Record<string, NodeMetadataResult>,
  status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 },
  statusFactory: () => OpcUaStatus = () => status,
): OpcUaGateway & { writeNative: ReturnType<typeof vi.fn> } {
  const writeNative = vi.fn(() => Promise.resolve({ kind: 'operation' as const }));
  return {
    status: () => Promise.resolve(statusFactory()),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: (): Promise<BrowseNodeResult[]> => Promise.resolve([]),
    read: (nodeId): Promise<ReadValueResult> => {
      const result: ReadValueResult = { nodeId, value: true };
      const dataType = metadata[nodeId]?.dataType;
      if (dataType !== undefined) result.dataType = dataType;
      return Promise.resolve(result);
    },
    readMany: (nodeIds) => Promise.resolve(nodeIds.map((nodeId) => ({ nodeId, value: true }))),
    writeNative,
    getNodeMetadata: (nodeId) => {
      const result = metadata[nodeId];
      if (result === undefined) throw new Error('BadNodeIdUnknown\nstack trace should not leak');
      return Promise.resolve(result);
    },
  };
}

function healthyAuditSink(): AuditSink {
  return {
    health: () => Promise.resolve({ healthy: true }),
    append: (record) => Promise.resolve({ id: record.id }),
  };
}
