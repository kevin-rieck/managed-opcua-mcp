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
  audit: { file: './audit.jsonl', maxReasonLength: 8 },
  controls: {
    defaults: { cooldownMs: 2500, mediumConfirmationTtlMs: 60000 },
    items: [
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
const controlsConfig = config.controls;
if (controlsConfig === undefined) throw new Error('Expected controls in test config.');

describe('medium-risk Control Confirmation MCP tools', () => {
  it('prepares a medium-risk Semantic Control with a token, current value, and audit record', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.Mode': {
          nodeId: 'ns=2;s=Machine.Mode',
          value: 'MAN',
          dataType: 'String',
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
      const result = await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'switch to auto for scheduled test',
      });

      expect(result).toMatchObject({
        ok: true,
        controlName: 'operating_mode',
        nodeId: 'ns=2;s=Machine.Mode',
        requestedValue: 'automatic',
        rawRequestedValue: 'AUTO',
        riskLevel: 'medium',
        riskNote: 'Changes operator workflow.',
        currentValue: { ok: true, value: 'manual', rawValue: 'MAN', opcuaStatus: 'Good' },
        commitAvailable: true,
      });
      expect(typeof (result as { token: unknown }).token).toBe('string');
      expect(typeof (result as { expiresAt: unknown }).expiresAt).toBe('string');
      expect(operations).toEqual(['read', 'audit:control.prepare.completed']);
      expect(auditRecords).toMatchObject([
        {
          event: 'control.prepare.completed',
          result: 'prepared',
          controlName: 'operating_mode',
          nodeId: 'ns=2;s=Machine.Mode',
          requestedValue: 'automatic',
          rawRequestedValue: 'AUTO',
          riskLevel: 'medium',
          reason: 'switch t',
          configHash: 'abc123',
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects prepare when required current value cannot be read', async () => {
    const strictConfig = appConfigSchema.parse({
      ...config,
      controls: {
        ...controlsConfig,
        items: [
          {
            ...controlsConfig.items[0],
            requireCurrentValueForConfirmation: true,
          },
        ],
      },
    });
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({ operations, values: {}, writeResult: { opcuaStatus: 'Good' } });
    const { client, server } = await connectTestClient(
      strictConfig,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'opcua_read_failed',
        message: 'BadNodeIdUnknown',
        controlName: 'operating_mode',
        auditId: auditRecords[0]?.id,
      });
      expect(operations).toEqual(['read', 'audit:control.prepare.rejected']);
      expect(gateway.write).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('audits rejected prepare attempts for invalid requested values', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({ operations, values: {}, writeResult: { opcuaStatus: 'Good' } });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'invalid',
        reason: 'scheduled test',
      });

      expect(result).toEqual({
        ok: false,
        code: 'invalid_control_value',
        message: 'Value is not one of the configured allowedValues.',
        controlName: 'operating_mode',
        auditId: auditRecords[0]?.id,
      });
      expect(operations).toEqual(['audit:control.prepare.rejected']);
      expect(auditRecords).toMatchObject([
        {
          event: 'control.prepare.rejected',
          result: 'rejected',
          controlName: 'operating_mode',
          riskLevel: 'medium',
          reason: 'schedule',
          errorMessage: 'Value is not one of the configured allowedValues.',
        },
      ]);
      expect(gateway.write).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('audits invalid confirmation token commits without touching OPC UA', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({ operations, values: {}, writeResult: { opcuaStatus: 'Good' } });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const result = await callJsonTool(client, 'commit_control', { token: 'not-a-token' });

      expect(result).toEqual({
        ok: false,
        code: 'invalid_confirmation_token',
        message: 'Invalid confirmation token.',
        auditId: auditRecords[0]?.id,
      });
      expect(operations).toEqual(['audit:control.commit.rejected']);
      expect(gateway.write).not.toHaveBeenCalled();
      expect(auditRecords).toMatchObject([
        {
          event: 'control.commit.rejected',
          result: 'rejected',
          configHash: 'abc123',
          errorMessage: 'Invalid confirmation token.',
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects commit when observed current value changed after prepare', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const values: Record<string, ReadValueResult> = {
      'ns=2;s=Machine.Mode': {
        nodeId: 'ns=2;s=Machine.Mode',
        value: 'MAN',
        dataType: 'String',
        opcuaStatus: 'Good',
      },
    };
    const gateway = fakeGateway({ operations, values, writeResult: { opcuaStatus: 'Good' } });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const prepared = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      values['ns=2;s=Machine.Mode'] = {
        nodeId: 'ns=2;s=Machine.Mode',
        value: 'AUTO',
        dataType: 'String',
        opcuaStatus: 'Good',
      };
      operations.length = 0;

      const result = await callJsonTool(client, 'commit_control', { token: prepared.token });

      expect(result).toMatchObject({
        ok: false,
        code: 'confirmation_current_value_changed',
        message: 'Current value changed after prepare.',
        controlName: 'operating_mode',
        currentValue: { ok: true, value: 'automatic', rawValue: 'AUTO', opcuaStatus: 'Good' },
      });
      expect(operations).toEqual(['read', 'audit:control.commit.rejected']);
      expect(gateway.write).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('audits and rejects commits after OPC UA reconnects', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 };
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.Mode': {
          nodeId: 'ns=2;s=Machine.Mode',
          value: 'MAN',
          dataType: 'String',
          opcuaStatus: 'Good',
        },
      },
      writeResult: { opcuaStatus: 'Good' },
      status,
    });
    const { client, server } = await connectTestClient(
      config,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const prepared = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      status.connectionGeneration = 2;
      operations.length = 0;

      const result = await callJsonTool(client, 'commit_control', { token: prepared.token });

      expect(result).toEqual({
        ok: false,
        code: 'confirmation_token_connection_changed',
        message: 'OPC UA connection changed after prepare.',
      });
      expect(operations).toEqual(['audit:control.commit.rejected']);
      expect(gateway.write).not.toHaveBeenCalled();
      expect(auditRecords.at(-1)).toMatchObject({
        event: 'control.commit.rejected',
        result: 'rejected',
        errorMessage: 'Connection changed after prepare.',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('audits and rejects expired confirmation tokens at commit', async () => {
    const expiringConfig = appConfigSchema.parse({
      ...config,
      controls: {
        ...controlsConfig,
        defaults: { ...controlsConfig.defaults, mediumConfirmationTtlMs: 1 },
      },
    });
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.Mode': {
          nodeId: 'ns=2;s=Machine.Mode',
          value: 'MAN',
          dataType: 'String',
          opcuaStatus: 'Good',
        },
      },
      writeResult: { opcuaStatus: 'Good' },
    });
    const { client, server } = await connectTestClient(
      expiringConfig,
      gateway,
      recordingAuditSink(auditRecords, operations),
    );

    try {
      const prepared = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
      operations.length = 0;

      const result = await callJsonTool(client, 'commit_control', { token: prepared.token });

      expect(result).toEqual({
        ok: false,
        code: 'confirmation_token_expired',
        message: 'Confirmation token expired.',
        auditId: auditRecords.at(-1)?.id,
      });
      expect(operations).toEqual(['audit:control.commit.rejected']);
      expect(gateway.write).not.toHaveBeenCalled();
      expect(auditRecords.at(-1)).toMatchObject({
        event: 'control.commit.rejected',
        result: 'rejected',
        controlName: 'operating_mode',
        errorMessage: 'Confirmation token expired.',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects commit while Semantic Control cooldown is active', async () => {
    const operations: string[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.Mode': {
          nodeId: 'ns=2;s=Machine.Mode',
          value: 'AUTO',
          dataType: 'String',
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
      const first = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      await callJsonTool(client, 'commit_control', { token: first.token });
      const second = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      operations.length = 0;

      const result = await callJsonTool(client, 'commit_control', { token: second.token });

      expect(result).toMatchObject({
        ok: false,
        code: 'control_cooldown_active',
        message: 'Semantic Control cooldown is active.',
        controlName: 'operating_mode',
        cooldownMs: 2500,
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
      expect(operations).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('commits a prepared medium-risk Semantic Control through the safe write path', async () => {
    const operations: string[] = [];
    const auditRecords: AuditRecord[] = [];
    const gateway = fakeGateway({
      operations,
      values: {
        'ns=2;s=Machine.Mode': {
          nodeId: 'ns=2;s=Machine.Mode',
          value: 'AUTO',
          dataType: 'String',
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
      const prepared = (await callJsonTool(client, 'prepare_control', {
        controlName: 'operating_mode',
        value: 'automatic',
        reason: 'scheduled test',
      })) as { token: string };
      operations.length = 0;

      const result = await callJsonTool(client, 'commit_control', { token: prepared.token });

      expect(result).toMatchObject({
        ok: true,
        controlName: 'operating_mode',
        nodeId: 'ns=2;s=Machine.Mode',
        requestedValue: 'automatic',
        rawRequestedValue: 'AUTO',
        riskLevel: 'medium',
        opcuaStatus: 'Good',
        verification: { ok: true, value: 'automatic', rawValue: 'AUTO', opcuaStatus: 'Good' },
      });
      expect(gateway.write).toHaveBeenCalledTimes(1);
      expect(gateway.write).toHaveBeenCalledWith('ns=2;s=Machine.Mode', 'String', 'AUTO');
      expect(operations).toEqual([
        'read',
        'audit:control.commit.requested',
        'write',
        'read',
        'audit:control.commit.completed',
      ]);
      expect(auditRecords.at(-2)).toMatchObject({
        event: 'control.commit.requested',
        result: 'accepted',
        controlName: 'operating_mode',
        requestedValue: 'automatic',
        rawRequestedValue: 'AUTO',
        riskLevel: 'medium',
        reason: 'schedule',
      });
      expect(auditRecords.at(-1)).toMatchObject({
        event: 'control.commit.completed',
        result: 'succeeded',
        opcuaStatus: 'Good',
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
  status = { state: 'connected', connectionGeneration: 1 },
}: {
  operations: string[];
  values: Record<string, ReadValueResult>;
  writeResult: WriteValueResult;
  status?: OpcUaStatus;
}): OpcUaGateway & { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(() => {
    operations.push('write');
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
