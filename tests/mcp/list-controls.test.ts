import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { AuditSink } from '../../src/audit/audit-sink.js';
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
  read: { roots: [] },
  audit: { file: './audit.jsonl' },
  controls: {
    defaults: { cooldownMs: 2500, mediumConfirmationTtlMs: 60000 },
    items: [
      {
        name: 'motor_enabled',
        group: 'machine/motor',
        description: 'Enables the motor.',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        dataType: 'Boolean',
        falseLabel: 'disabled',
        trueLabel: 'enabled',
        riskLevel: 'low',
        riskNote: 'Can start motion.',
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
        riskLevel: 'medium',
        riskNote: 'Changes operator workflow.',
        requireCurrentValueForConfirmation: true,
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
        riskNote: 'Affects production speed.',
        cooldownMs: 5000,
      },
    ],
  },
});

describe('list_controls MCP tool', () => {
  it('lists available Semantic Controls with agent-facing metadata without reading current OPC UA values', async () => {
    const gateway = fakeGateway({}, { state: 'connected', connectionGeneration: 1 });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});

      expect(gateway.read).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        controls: [
          {
            name: 'motor_enabled',
            group: 'machine/motor',
            description: 'Enables the motor.',
            nodeId: 'ns=2;s=Machine.MotorEnabled',
            riskLevel: 'low',
            riskNote: 'Can start motion.',
            requiresConfirmation: false,
            requiresReason: false,
            value: { type: 'boolean', falseLabel: 'disabled', trueLabel: 'enabled' },
            cooldownMs: 2500,
            available: true,
            unavailableReasons: [],
          },
          {
            name: 'operating_mode',
            description: 'Sets operating mode.',
            nodeId: 'ns=2;s=Machine.Mode',
            riskLevel: 'medium',
            riskNote: 'Changes operator workflow.',
            requiresConfirmation: true,
            requiresReason: true,
            requireCurrentValueForConfirmation: true,
            value: {
              type: 'enum',
              dataType: 'String',
              allowedValues: [
                { label: 'manual', value: 'MAN' },
                { label: 'automatic', value: 'AUTO' },
              ],
            },
            cooldownMs: 2500,
            available: true,
            unavailableReasons: [],
          },
          {
            name: 'speed_setpoint',
            description: 'Sets speed.',
            nodeId: 'ns=2;s=Machine.Speed',
            riskLevel: 'low',
            riskNote: 'Affects production speed.',
            requiresConfirmation: false,
            requiresReason: false,
            value: { type: 'number', dataType: 'Double', min: 0, max: 1800, unit: 'rpm' },
            cooldownMs: 5000,
            available: true,
            unavailableReasons: [],
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('marks Semantic Controls unavailable while the OPC UA Server is disconnected', async () => {
    const gateway = fakeGateway({}, { state: 'reconnecting', connectionGeneration: 7 });
    const { client, server } = await connectTestClient(config, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});

      expect(result).toMatchObject({
        ok: true,
        controls: [
          {
            name: 'motor_enabled',
            available: false,
            unavailableReasons: [
              {
                code: 'opcua_disconnected',
                message: 'OPC UA Server is not connected.',
                connection: { state: 'reconnecting', connectionGeneration: 7 },
              },
            ],
          },
          {
            name: 'operating_mode',
            available: false,
            unavailableReasons: [
              {
                code: 'opcua_disconnected',
                message: 'OPC UA Server is not connected.',
                connection: { state: 'reconnecting', connectionGeneration: 7 },
              },
            ],
          },
          {
            name: 'speed_setpoint',
            available: false,
            unavailableReasons: [
              {
                code: 'opcua_disconnected',
                message: 'OPC UA Server is not connected.',
                connection: { state: 'reconnecting', connectionGeneration: 7 },
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

  it('returns multiple machine-readable unavailable reasons for each affected Semantic Control', async () => {
    const disabledConfig = appConfigSchema.parse({
      ...config,
      controls: { ...config.controls, enabled: false },
    });
    const gateway = fakeGateway({}, { state: 'disconnected', connectionGeneration: 3 });
    const auditSink: AuditSink = {
      health: () => Promise.resolve({ healthy: false, reason: 'audit file is not writable' }),
      append: (record) => Promise.resolve({ id: record.id }),
    };
    const { client, server } = await connectTestClient(disabledConfig, gateway, auditSink);

    try {
      const result = await callJsonTool(client, 'list_controls', {});

      expect(result).toMatchObject({ ok: true });
      const controls = (result as { controls: unknown[] }).controls;
      expect(controls[0]).toMatchObject({
        name: 'motor_enabled',
        available: false,
        unavailableReasons: [
          { code: 'controls_disabled', message: 'Semantic Controls are disabled.' },
          {
            code: 'opcua_disconnected',
            message: 'OPC UA Server is not connected.',
            connection: { state: 'disconnected', connectionGeneration: 3 },
          },
          {
            code: 'audit_unavailable',
            message: 'Audit logging is unavailable: audit file is not writable',
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps Semantic Controls visible but unavailable when controls are disabled', async () => {
    const disabledConfig = appConfigSchema.parse({
      ...config,
      controls: { ...config.controls, enabled: false },
    });
    const gateway = fakeGateway({}, { state: 'connected', connectionGeneration: 1 });
    const { client, server } = await connectTestClient(disabledConfig, gateway);

    try {
      const result = await callJsonTool(client, 'list_controls', {});

      expect(result).toMatchObject({
        ok: true,
        controls: [
          {
            name: 'motor_enabled',
            available: false,
            unavailableReasons: [
              { code: 'controls_disabled', message: 'Semantic Controls are disabled.' },
            ],
          },
          {
            name: 'operating_mode',
            available: false,
            unavailableReasons: [
              { code: 'controls_disabled', message: 'Semantic Controls are disabled.' },
            ],
          },
          {
            name: 'speed_setpoint',
            available: false,
            unavailableReasons: [
              { code: 'controls_disabled', message: 'Semantic Controls are disabled.' },
            ],
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(
  config: AppConfig,
  gateway: OpcUaGateway,
  auditSink: AuditSink = healthyAuditSink(),
) {
  const server = createMcpServer({ config, configHash: 'abc123', gateway, auditSink });
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

function healthyAuditSink(): AuditSink {
  return {
    health: () => Promise.resolve({ healthy: true }),
    append: (record) => Promise.resolve({ id: record.id }),
  };
}
