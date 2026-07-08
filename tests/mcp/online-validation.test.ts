import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { AuditSink } from '../../src/audit/audit-sink.js';
import type { BrowseNodeResult, NodeMetadataResult, OpcUaGateway, OpcUaStatus, ReadValueResult } from '../../src/opcua/gateway.js';

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
  read: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
  audit: { file: './audit.jsonl' },
  controls: {
    items: [
      {
        name: 'motor_enabled',
        description: 'Enables motor.',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        dataType: 'Boolean',
        falseLabel: 'disabled',
        trueLabel: 'enabled',
        riskLevel: 'low',
        riskNote: 'Can start motion.',
      },
    ],
  },
});

describe('online validation', () => {
  it('reports pending validation while the OPC UA Server is unavailable', async () => {
    const gateway = fakeGateway(
      {},
      { state: 'reconnecting', connectionGeneration: 4 },
    );
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

  it('reports valid config when read roots and Semantic Control targets match server metadata', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});
      const status = await readJsonResource(client, 'opcua://status');
      expect(status).toMatchObject({ onlineValidation: { state: 'valid', reasons: [] } });
      expect(result).toMatchObject({
        controls: [{ name: 'motor_enabled', available: true, unavailableReasons: [] }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports invalid read roots without hiding available controls', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: false },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});
      const status = await readJsonResource(client, 'opcua://status');
      expect(status).toMatchObject({
        onlineValidation: {
          state: 'invalid',
          reasons: [{ code: 'read_root_not_browseable', nodeId: 'ns=2;s=Machine' }],
        },
      });
      expect(result).toMatchObject({ controls: [{ name: 'motor_enabled', available: true }] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists online-invalid Semantic Controls as unavailable with structured reasons', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: false,
        dataType: 'String',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});
      expect(result).toMatchObject({
        controls: [
          {
            name: 'motor_enabled',
            available: false,
            unavailableReasons: [
              { code: 'control_target_not_writable', controlName: 'motor_enabled' },
              {
                code: 'control_target_datatype_mismatch',
                expectedDataType: 'Boolean',
                actualDataType: 'String',
              },
            ],
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects writes for online-invalid controls before OPC UA write', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: false,
        dataType: 'Boolean',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'online_validation_failed',
        onlineValidation: {
          state: 'invalid',
          reasons: [{ code: 'control_target_not_writable' }],
        },
      });
      expect(gateway.write).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('recovers after validation changes on a new OPC UA connection generation', async () => {
    let generation = 1;
    const metadata: Record<string, NodeMetadataResult> = {
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: false,
        dataType: 'Boolean',
      },
    };
    const gateway = fakeGateway(metadata, undefined, () => ({
      state: 'connected',
      connectionGeneration: generation,
    }));
    const { client, server } = await connectTestClient(config, gateway);

    try {
      expect(await callJsonTool(client, 'list_controls', {})).toMatchObject({
        controls: [{ available: false }],
      });

      metadata['ns=2;s=Machine.MotorEnabled'] = {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      };
      generation = 2;

      expect(await callJsonTool(client, 'list_controls', {})).toMatchObject({
        controls: [{ available: true, unavailableReasons: [] }],
      });
      expect(await readJsonResource(client, 'opcua://status')).toMatchObject({
        onlineValidation: { state: 'valid' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(config: AppConfig, gateway: OpcUaGateway) {
  const server = createMcpServer({ config, configHash: 'abc123', gateway, auditSink: healthyAuditSink() });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as ToolTextResult;
  const content = result.content[0];
  if (content === undefined) throw new Error(`No text content for ${name}`);
  return JSON.parse(content.text);
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
): OpcUaGateway & { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(() => Promise.resolve({ opcuaStatus: 'Good' }));
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
    write,
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
