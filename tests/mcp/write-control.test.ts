import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRecord, AuditSink } from '../../src/audit/audit-sink.js';
import { appConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type {
  BrowseNodeResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
  WriteValueResult,
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
  audit: { file: './audit.jsonl', maxReasonLength: 1000 },
  controls: {
    defaults: { cooldownMs: 2500, mediumConfirmationTtlMs: 60000 },
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

describe('write_control MCP tool', () => {
  it('writes a low-risk Semantic Control and audits the Control Attempt before and after the OPC UA write', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.MotorEnabled': {
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          value: true,
          dataType: 'Boolean',
          opcuaStatus: 'Good',
        },
      },
      writeResult: { opcuaStatus: 'Good' },
    });
    const auditSink = recordingAuditSink(auditRecords, operations);
    const { client, server } = await connectTestClient(config, gateway, auditSink);

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
        reason: 'start test run',
      });

      expect(result).toMatchObject({
        ok: true,
        controlName: 'motor_enabled',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        riskLevel: 'low',
        opcuaStatus: 'Good',
        verification: { ok: true, value: 'enabled', rawValue: true, opcuaStatus: 'Good' },
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
      expect(gateway.write).toHaveBeenCalledWith('ns=2;s=Machine.MotorEnabled', 'Boolean', true);
      expect(operations).toEqual(['audit:control.write.requested', 'write', 'read', 'audit:control.write.completed']);
      expect(auditRecords).toMatchObject([
        {
          event: 'control.write.requested',
          result: 'accepted',
          controlName: 'motor_enabled',
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          requestedValue: 'enabled',
          rawRequestedValue: true,
          riskLevel: 'low',
          reason: 'start test run',
          configHash: 'abc123',
        },
        {
          event: 'control.write.completed',
          result: 'succeeded',
          controlName: 'motor_enabled',
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          requestedValue: 'enabled',
          rawRequestedValue: true,
          riskLevel: 'low',
          opcuaStatus: 'Good',
          configHash: 'abc123',
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects writes while a Semantic Control cooldown is active', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.MotorEnabled': {
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          value: true,
          dataType: 'Boolean',
          opcuaStatus: 'Good',
        },
      },
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink([], operations),
    );

    try {
      await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'control_cooldown_active',
        message: 'Semantic Control cooldown is active.',
        controlName: 'motor_enabled',
        cooldownMs: 2500,
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects unknown Semantic Controls without touching OPC UA', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink([], operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'missing_control',
        value: true,
      });

      expect(result).toEqual({
        ok: false,
        code: 'unknown_control',
        message: 'Unknown Semantic Control: missing_control',
      });
      expect(gateway.write).not.toHaveBeenCalled();
      expect(operations).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects writes while the OPC UA Server is disconnected without queuing writes', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
      status: { state: 'reconnecting', connectionGeneration: 7 },
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink([], operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toEqual({
        ok: false,
        code: 'opcua_not_connected',
        message: 'OPC UA Server is not connected yet.',
        connection: { state: 'reconnecting', connectionGeneration: 7 },
      });
      expect(gateway.write).not.toHaveBeenCalled();
      expect(operations).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects writes when audit logging is unavailable before touching OPC UA', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
    });
    const auditSink: AuditSink = {
      health: () => Promise.resolve({ healthy: false, reason: 'disk full' }),
      append: (record) => Promise.resolve({ id: record.id }),
    };
    const { client, server } = await connectTestClient(config, gateway, auditSink);

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toEqual({
        ok: false,
        code: 'audit_unavailable',
        message: 'Audit logging is unavailable: disk full',
      });
      expect(gateway.write).not.toHaveBeenCalled();
      expect(operations).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects writes while Semantic Controls are disabled', async () => {
    const disabledConfig = appConfigSchema.parse({
      ...config,
      controls: { ...config.controls, enabled: false },
    });
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      disabledConfig,
      gateway,
      recordingAuditSink([], operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toEqual({
        ok: false,
        code: 'controls_disabled',
        message: 'Semantic Controls are disabled.',
      });
      expect(gateway.write).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects medium-risk Semantic Controls with Control Confirmation guidance', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'operating_mode',
        value: 'automatic',
      });

      expect(result).toEqual({
        ok: false,
        code: 'confirmation_required',
        message: 'Medium-risk Semantic Controls require prepare_control and commit_control.',
      });
      expect(gateway.write).not.toHaveBeenCalled();
      expect(auditRecords).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports verification failure when readback does not match the requested value', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.MotorEnabled': {
          nodeId: 'ns=2;s=Machine.MotorEnabled',
          value: false,
          dataType: 'Boolean',
          opcuaStatus: 'Good',
        },
      },
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'write_accepted_verification_failed',
        controlName: 'motor_enabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        opcuaStatus: 'Good',
        verification: { ok: false, value: 'disabled', rawValue: false, opcuaStatus: 'Good' },
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
      expect(auditRecords[1]).toMatchObject({
        event: 'control.write.completed',
        result: 'verification_failed',
        opcuaStatus: 'Good',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns structured OPC UA write errors without retrying the Control Operation', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
      writeError: Object.assign(new Error('BadUserAccessDenied\nstack details'), {
        code: 'BadUserAccessDenied',
      }),
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'enabled',
      });

      expect(result).toEqual({
        ok: false,
        code: 'BadUserAccessDenied',
        message: 'BadUserAccessDenied',
        controlName: 'motor_enabled',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
      expect(operations).toEqual(['audit:control.write.requested', 'write', 'audit:control.write.failed']);
      expect(auditRecords[1]).toMatchObject({
        event: 'control.write.failed',
        result: 'failed',
        errorMessage: 'BadUserAccessDenied',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid low-risk control values without performing an OPC UA write', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {},
      writeResult: { opcuaStatus: 'Good' },
    });
    const auditRecords: AuditRecord[] = [];
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'write_control', {
        controlName: 'motor_enabled',
        value: 'maybe',
      });

      expect(result).toEqual({
        ok: false,
        code: 'invalid_control_value',
        message: 'Expected boolean or one of disabled, enabled.',
        controlName: 'motor_enabled',
      });
      expect(gateway.write).not.toHaveBeenCalled();
      expect(auditRecords).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectTestClient(
  config: AppConfig,
  gateway: OpcUaGateway,
  auditSink: AuditSink,
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

function fakeGateway({
  operations,
  values,
  writeResult,
  writeError,
  status = { state: 'connected', connectionGeneration: 1 },
}: {
  operations: string[];
  values: Record<string, ReadValueResult>;
  writeResult: WriteValueResult;
  writeError?: Error;
  status?: OpcUaStatus;
}): OpcUaGateway & { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(() => {
    operations.push('write');
    if (writeError !== undefined) return Promise.reject(writeError);
    return Promise.resolve(writeResult);
  });
  return {
    status: () => Promise.resolve(status),
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    browse: (): Promise<BrowseNodeResult[]> => Promise.resolve([]),
    read: (nodeId: string) => {
      operations.push('read');
      const value = values[nodeId];
      if (value === undefined) throw new Error('BadNodeIdUnknown');
      return Promise.resolve(value);
    },
    readMany: (nodeIds) =>
      Promise.resolve(
        nodeIds.map((nodeId) => {
          const value = values[nodeId];
          if (value === undefined) throw new Error('BadNodeIdUnknown');
          return value;
        }),
      ),
    write,
  };
}

function recordingAuditSink(records: AuditRecord[], operations: string[]): AuditSink {
  return {
    health: () => Promise.resolve({ healthy: true }),
    append: (record) => {
      operations.push(`audit:${record.event}`);
      records.push(record);
      return Promise.resolve({ id: record.id });
    },
  };
}
