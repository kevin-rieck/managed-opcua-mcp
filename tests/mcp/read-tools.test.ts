import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type {
  BrowseNodeResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
} from '../../src/opcua/gateway.js';

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
    maxReadBatchSize: 2,
    roots: [{ nodeId: 'ns=2;s=Machine.Temperature', label: 'temperature' }],
  },
  audit: { file: './audit.jsonl' },
  controls: {
    items: [
      {
        name: 'motor_enabled',
        description: 'Enables the motor.',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        dataType: 'Boolean',
        falseLabel: 'disabled',
        trueLabel: 'enabled',
        riskLevel: 'low',
        riskNote: 'Test control.',
      },
      {
        name: 'operating_mode',
        description: 'Sets operating mode.',
        nodeId: 'ns=2;s=Machine.Mode',
        dataType: 'String',
        allowedValues: [
          { label: 'manual', value: 'MAN' },
          { label: 'automatic', value: 'AUTO' },
        ],
        riskLevel: 'low',
        riskNote: 'Test control.',
      },
      {
        name: 'speed_setpoint',
        description: 'Sets speed.',
        nodeId: 'ns=2;s=Machine.Speed',
        dataType: 'Double',
        unit: 'rpm',
        min: 0,
        max: 1800,
        riskLevel: 'low',
        riskNote: 'Test control.',
      },
    ],
  },
});

describe('read_node MCP tool', () => {
  it('reads a direct NodeId and preserves OPC UA metadata', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine.Temperature': {
        nodeId: 'ns=2;s=Machine.Temperature',
        dataType: 'Double',
        value: 72.5,
        opcuaStatus: 'Good',
        sourceTimestamp: '2026-07-07T10:00:00.000Z',
        serverTimestamp: '2026-07-07T10:00:01.000Z',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'read_node', {
        nodeId: 'ns=2;s=Machine.Temperature',
      });

      expect(gateway.read).toHaveBeenCalledWith('ns=2;s=Machine.Temperature');
      expect(result).toEqual({
        ok: true,
        result: {
          ok: true,
          nodeId: 'ns=2;s=Machine.Temperature',
          label: 'temperature',
          value: 72.5,
          dataType: 'Double',
          opcuaStatus: 'Good',
          sourceTimestamp: '2026-07-07T10:00:00.000Z',
          serverTimestamp: '2026-07-07T10:00:01.000Z',
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads by configured label and normalizes Semantic Control target values', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine.MotorEnabled': {
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        dataType: 'Boolean',
        value: true,
        opcuaStatus: 'Good',
      },
      'ns=2;s=Machine.Mode': {
        nodeId: 'ns=2;s=Machine.Mode',
        dataType: 'String',
        value: 'AUTO',
        opcuaStatus: 'Good',
      },
      'ns=2;s=Machine.Speed': {
        nodeId: 'ns=2;s=Machine.Speed',
        dataType: 'Double',
        value: 900,
        opcuaStatus: 'Good',
      },
    });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      await expect(callJsonTool(client, 'read_node', { label: 'motor_enabled' })).resolves.toEqual({
        ok: true,
        result: {
          ok: true,
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          label: 'motor_enabled',
          value: 'enabled',
          rawValue: true,
          dataType: 'Boolean',
          opcuaStatus: 'Good',
        },
      });
      await expect(callJsonTool(client, 'read_node', { label: 'operating_mode' })).resolves.toEqual(
        {
          ok: true,
          result: {
            ok: true,
            nodeId: 'ns=2;s=Machine.Mode',
            label: 'operating_mode',
            value: 'automatic',
            rawValue: 'AUTO',
            dataType: 'String',
            opcuaStatus: 'Good',
          },
        },
      );
      await expect(callJsonTool(client, 'read_node', { label: 'speed_setpoint' })).resolves.toEqual(
        {
          ok: true,
          result: {
            ok: true,
            nodeId: 'ns=2;s=Machine.Speed',
            label: 'speed_setpoint',
            value: 900,
            dataType: 'Double',
            unit: 'rpm',
            opcuaStatus: 'Good',
          },
        },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('read_nodes MCP tool', () => {
  it('returns partial success with per-node errors', async () => {
    const gateway = fakeGateway({
      'ns=2;s=Machine.Temperature': {
        nodeId: 'ns=2;s=Machine.Temperature',
        dataType: 'Double',
        value: 72.5,
        opcuaStatus: 'Good',
      },
    });
    gateway.read.mockRejectedValueOnce(
      Object.assign(new Error('BadUserAccessDenied\nsecret stack'), {
        code: 'BadUserAccessDenied',
      }),
    );
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'read_nodes', {
        identifiers: [{ nodeId: 'ns=2;s=Denied' }, { label: 'temperature' }],
      });

      expect(result).toEqual({
        ok: false,
        results: [
          {
            ok: false,
            nodeId: 'ns=2;s=Denied',
            code: 'BadUserAccessDenied',
            message: 'BadUserAccessDenied',
          },
          {
            ok: true,
            nodeId: 'ns=2;s=Machine.Temperature',
            label: 'temperature',
            value: 72.5,
            dataType: 'Double',
            opcuaStatus: 'Good',
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects batches larger than read.maxReadBatchSize without reading live Nodes', async () => {
    const gateway = fakeGateway({});
    const { client, server } = await connectTestClient(config, gateway);

    try {
      await expect(
        callJsonTool(client, 'read_nodes', {
          identifiers: [
            { nodeId: 'ns=2;s=One' },
            { nodeId: 'ns=2;s=Two' },
            { nodeId: 'ns=2;s=Three' },
          ],
        }),
      ).resolves.toEqual({
        ok: false,
        code: 'read_batch_too_large',
        message: 'Batch size 3 exceeds configured maximum 2.',
      });
      expect(gateway.read).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns structured rejections for ambiguous identifiers, unknown labels, and disconnected reads', async () => {
    const gateway = fakeGateway({}, { state: 'connecting', connectionGeneration: 0 });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      await expect(
        callJsonTool(client, 'read_node', { nodeId: 'ns=2;s=Any', label: 'temperature' }),
      ).resolves.toMatchObject({ ok: false, code: 'ambiguous_identifier' });
      await expect(callJsonTool(client, 'read_node', { label: 'unknown' })).resolves.toMatchObject({
        ok: false,
        code: 'unknown_read_label',
      });
      await expect(
        callJsonTool(client, 'read_node', { nodeId: 'ns=2;s=Any' }),
      ).resolves.toMatchObject({
        ok: false,
        code: 'opcua_not_connected',
        connection: { state: 'connecting', connectionGeneration: 0 },
      });
      expect(gateway.read).not.toHaveBeenCalled();
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
  values: Record<string, ReadValueResult>,
  status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 },
): OpcUaGateway & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn((nodeId: string) => {
    const value = values[nodeId];
    if (value === undefined)
      throw Object.assign(new Error('BadNodeIdUnknown'), { code: 'BadNodeIdUnknown' });
    return Promise.resolve(value);
  });
  return {
    status: () => Promise.resolve(status),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: (): Promise<BrowseNodeResult[]> => Promise.resolve([]),
    read,
    readMany: (nodeIds) => Promise.all(nodeIds.map((nodeId) => read(nodeId))),
    write: () => Promise.reject(new Error('not used')),
  };
}
