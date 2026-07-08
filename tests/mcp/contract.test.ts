import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRecord, AuditSink } from '../../src/audit/audit-sink.js';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type {
  BrowseNodeResult,
  NodeMetadataResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
  WriteValueResult,
} from '../../src/opcua/gateway.js';

interface ToolTextResult {
  content: { type: 'text'; text: string }[];
}

const contractConfig = appConfigSchema.parse({
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
    maxReadBatchSize: 3,
    roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' }],
  },
  audit: { file: './audit.jsonl', maxReasonLength: 1000 },
  controls: {
    defaults: { cooldownMs: 0, mediumConfirmationTtlMs: 60000 },
    items: [
      {
        name: 'motor_enabled',
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
      },
    ],
  },
});

describe('end-to-end MCP contract', () => {
  it('exposes stable status, config summary, and read scope resources', async () => {
    const { client, server } = await connectTestClient(contractConfig, fakeGateway());

    try {
      await expect(readJsonResource(client, 'opcua://status')).resolves.toMatchObject({
        connection: { state: 'connected', connectionGeneration: 1 },
        controls: { configured: 2, lowRisk: 1, mediumRisk: 1, enabled: true },
        audit: { healthy: true },
        configHash: 'contract-hash',
      });
      await expect(readJsonResource(client, 'opcua://config/summary')).resolves.toMatchObject({
        version: 1,
        connection: { auth: { type: 'anonymous' } },
        controls: { enabled: true, configured: 2 },
        configHash: 'contract-hash',
      });
      await expect(readJsonResource(client, 'opcua://read-scope')).resolves.toEqual({
        defaultBrowseDepth: 2,
        maxBrowseDepth: 5,
        maxReadBatchSize: 3,
        roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine', description: 'Main machine.' }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('supports browse_node roots, Read Entry Point labels, and direct NodeIds', async () => {
    const gateway = fakeGateway({
      browseResults: [{ nodeId: 'ns=2;s=Machine.Motor', displayName: 'Motor', nodeClass: 'Object' }],
    });
    const { client, server } = await connectTestClient(contractConfig, gateway);

    try {
      await expect(callJsonTool(client, 'browse_node', {})).resolves.toMatchObject({
        ok: true,
        mode: 'read_entry_points',
        roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
      });
      await expect(callJsonTool(client, 'browse_node', { label: 'machine' })).resolves.toMatchObject({
        ok: true,
        mode: 'browse',
        start: { nodeId: 'ns=2;s=Machine', label: 'machine' },
        nodes: [{ nodeId: 'ns=2;s=Machine.Motor', displayName: 'Motor' }],
      });
      await expect(callJsonTool(client, 'browse_node', { nodeId: 'ns=2;s=Other', depth: 1 })).resolves.toMatchObject({
        ok: true,
        mode: 'browse',
        start: { nodeId: 'ns=2;s=Other' },
      });
      expect(gateway.browse).toHaveBeenCalledWith('ns=2;s=Machine', 2);
      expect(gateway.browse).toHaveBeenCalledWith('ns=2;s=Other', 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns read_node and read_nodes contracts including partial success', async () => {
    const gateway = fakeGateway({
      reads: {
        'ns=2;s=Machine.Temperature': { nodeId: 'ns=2;s=Machine.Temperature', dataType: 'Double', value: 72.5, opcuaStatus: 'Good' },
        'ns=2;s=Machine.MotorEnabled': { nodeId: 'ns=2;s=Machine.MotorEnabled', dataType: 'Boolean', value: true, opcuaStatus: 'Good' },
      },
    });
    const { client, server } = await connectTestClient(contractConfig, gateway);

    try {
      await expect(callJsonTool(client, 'read_node', { label: 'motor_enabled' })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, nodeId: 'ns=2;s=Machine.MotorEnabled', label: 'motor_enabled', value: 'enabled', rawValue: true },
      });
      await expect(
        callJsonTool(client, 'read_nodes', {
          identifiers: [{ nodeId: 'ns=2;s=Denied' }, { nodeId: 'ns=2;s=Machine.Temperature' }],
        }),
      ).resolves.toMatchObject({
        ok: false,
        results: [
          { ok: false, nodeId: 'ns=2;s=Denied', code: 'BadNodeIdUnknown' },
          { ok: true, nodeId: 'ns=2;s=Machine.Temperature', value: 72.5, opcuaStatus: 'Good' },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists available and unavailable Semantic Controls with structured reasons', async () => {
    const unavailableConfig = appConfigSchema.parse({
      ...contractConfig,
      controls: { ...contractConfig.controls, enabled: false },
    });
    const { client, server } = await connectTestClient(
      unavailableConfig,
      fakeGateway({ status: { state: 'reconnecting', connectionGeneration: 7 } }),
      { health: () => Promise.resolve({ healthy: false, reason: 'audit unavailable' }), append: (record) => Promise.resolve({ id: record.id }) },
    );

    try {
      const result = await callJsonTool(client, 'list_controls', {});
      expect(result).toMatchObject({ ok: true });
      const controls = (result as { controls: unknown[] }).controls;
      expect(controls[0]).toMatchObject({
        name: 'motor_enabled',
        riskLevel: 'low',
        available: false,
        unavailableReasons: [
          { code: 'controls_disabled' },
          { code: 'opcua_disconnected', connection: { state: 'reconnecting', connectionGeneration: 7 } },
          { code: 'audit_unavailable' },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns structured write_control contracts for success and expected domain failures', async () => {
    const gateway = fakeGateway({
      reads: {
        'ns=2;s=Machine.MotorEnabled': { nodeId: 'ns=2;s=Machine.MotorEnabled', value: true, dataType: 'Boolean', opcuaStatus: 'Good' },
      },
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(contractConfig, gateway);

    try {
      await expect(callJsonTool(client, 'write_control', { controlName: 'motor_enabled', value: 'enabled' })).resolves.toMatchObject({
        ok: true,
        controlName: 'motor_enabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        opcuaStatus: 'Good',
        verification: { ok: true, value: 'enabled', rawValue: true },
      });
      await expect(callJsonTool(client, 'write_control', { controlName: 'motor_enabled', value: 'maybe' })).resolves.toEqual({
        ok: false,
        code: 'invalid_control_value',
        message: 'Expected boolean or one of disabled, enabled.',
        controlName: 'motor_enabled',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('distinguishes OPC UA write errors, unknown outcomes, and verification mismatches', async () => {
    await withClient(
      fakeGateway({ writeError: Object.assign(new Error('BadUserAccessDenied\nstack'), { code: 'BadUserAccessDenied' }) }),
      async (client) => {
        await expect(callJsonTool(client, 'write_control', { controlName: 'motor_enabled', value: 'enabled' })).resolves.toEqual({
          ok: false,
          code: 'BadUserAccessDenied',
          message: 'BadUserAccessDenied',
          controlName: 'motor_enabled',
          nodeId: 'ns=2;s=Machine.MotorEnabled',
        });
      },
    );

    await withClient(
      fakeGateway({ writeResult: { opcuaStatus: 'Good' } }),
      async (client) => {
        await expect(callJsonTool(client, 'write_control', { controlName: 'motor_enabled', value: 'enabled' })).resolves.toMatchObject({
          ok: false,
          code: 'write_outcome_unknown',
          opcuaStatus: 'Good',
          verification: { ok: false, code: 'verification_unavailable', message: 'BadNodeIdUnknown' },
        });
      },
    );

    await withClient(
      fakeGateway({
        reads: { 'ns=2;s=Machine.MotorEnabled': { nodeId: 'ns=2;s=Machine.MotorEnabled', value: false, dataType: 'Boolean', opcuaStatus: 'Good' } },
        writeResult: { opcuaStatus: 'Good' },
      }),
      async (client) => {
        await expect(callJsonTool(client, 'write_control', { controlName: 'motor_enabled', value: 'enabled' })).resolves.toMatchObject({
          ok: false,
          code: 'write_accepted_verification_failed',
          verification: { ok: false, value: 'disabled', rawValue: false },
        });
      },
    );
  });

  it('supports prepare_control and commit_control success plus representative token rejection', async () => {
    const gateway = fakeGateway({
      reads: { 'ns=2;s=Machine.Mode': { nodeId: 'ns=2;s=Machine.Mode', value: 'AUTO', dataType: 'String', opcuaStatus: 'Good' } },
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(contractConfig, gateway);

    try {
      const prepared = await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      });
      expect(prepared).toMatchObject({ ok: true, controlName: 'operating_mode', commitAvailable: true });
      const token = (prepared as { token: string }).token;
      await expect(callJsonTool(client, 'commit_control', { token })).resolves.toMatchObject({
        ok: true,
        controlName: 'operating_mode',
        opcuaStatus: 'Good',
      });
      await expect(callJsonTool(client, 'commit_control', { token: 'missing-token' })).resolves.toMatchObject({
        ok: false,
        code: 'invalid_confirmation_token',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function withClient(gateway: OpcUaGateway, run: (client: Client) => Promise<void>): Promise<void> {
  const { client, server } = await connectTestClient(contractConfig, gateway);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function connectTestClient(config: AppConfig, gateway: OpcUaGateway, auditSink: AuditSink = recordingAuditSink()) {
  const server = createMcpServer({ config, configHash: 'contract-hash', gateway, auditSink });
  const client = new Client({ name: 'contract-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as ToolTextResult;
  const content = result.content[0];
  if (content === undefined) throw new Error(`No text content for ${name}`);
  return JSON.parse(content.text) as unknown;
}

async function readJsonResource(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') throw new Error(`No text content for ${uri}`);
  return JSON.parse(content.text) as unknown;
}

function fakeGateway(options: {
  status?: OpcUaStatus;
  browseResults?: BrowseNodeResult[];
  reads?: Record<string, ReadValueResult>;
  writeResult?: WriteValueResult;
  writeError?: Error;
  metadata?: Record<string, NodeMetadataResult>;
} = {}): OpcUaGateway & { browse: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
  const reads = options.reads ?? {};
  const browse = vi.fn(() => Promise.resolve(options.browseResults ?? []));
  const write = vi.fn(() => {
    if (options.writeError !== undefined) return Promise.reject(options.writeError);
    return Promise.resolve(options.writeResult ?? { opcuaStatus: 'Good' });
  });
  return {
    status: () => Promise.resolve(options.status ?? { state: 'connected', connectionGeneration: 1 }),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse,
    read: (nodeId) => {
      const value = reads[nodeId];
      if (value === undefined) return Promise.reject(Object.assign(new Error('BadNodeIdUnknown\nstack'), { code: 'BadNodeIdUnknown' }));
      return Promise.resolve(value);
    },
    readMany: (nodeIds) =>
      Promise.all(
        nodeIds.map((nodeId) =>
          reads[nodeId] === undefined
            ? Promise.reject(new Error('BadNodeIdUnknown'))
            : Promise.resolve(reads[nodeId]),
        ),
      ),
    write,
    getNodeMetadata: (nodeId) => Promise.resolve(options.metadata?.[nodeId] ?? {}),
  };
}

function recordingAuditSink(records: AuditRecord[] = []): AuditSink {
  return {
    health: () => Promise.resolve({ healthy: true }),
    append: (record) => {
      records.push(record);
      return Promise.resolve({ id: record.id });
    },
  };
}
