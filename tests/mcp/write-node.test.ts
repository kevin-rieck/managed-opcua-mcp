import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRecord, AuditSink } from '../../src/audit/audit-sink.js';
import { appConfigSchema } from '../../src/config/schema.js';
import type { NativeWriteResult, OpcUaGateway } from '../../src/opcua/gateway.js';
import { createMcpServer } from '../../src/mcp/server.js';

const config = appConfigSchema.parse({
  version: 2,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  audit: { file: './audit.jsonl', maxReasonLength: 3 },
});
const good = { value: 1, hex: '0x00000001', name: 'BadNamedGood' };
const bad = { value: 0x801f0000, hex: '0x801f0000', name: 'GoodNamedBad' };
const uncertain = { value: 0x40010000, hex: '0x40010000', name: 'Uncertain' };
const reserved = { value: 0xc0000001, hex: '0xc0000001', name: 'Reserved' };
const args = { nodeId: 'ns=0002;s=Motor;Speed', dataType: 'Boolean', value: true, reason: 'ok' };

function setup(
  options: {
    health?: 'bad' | 'throw';
    disconnected?: boolean;
    statusThrows?: boolean;
    failAppend?: number;
    result?: NativeWriteResult;
    throws?: boolean;
  } = {},
) {
  const records: AuditRecord[] = [];
  let appendCount = 0;
  const append = vi.fn((record: AuditRecord) => {
    if (++appendCount === options.failAppend)
      return Promise.reject(new Error('secret audit path\nstack'));
    records.push(record);
    return Promise.resolve({ id: record.id });
  });
  const auditSink = {
    health: vi.fn(() =>
      options.health === 'throw'
        ? Promise.reject(new Error('secret'))
        : Promise.resolve(
            options.health === 'bad'
              ? { healthy: false as const, reason: 'secret' }
              : { healthy: true as const },
          ),
    ),
    append,
  } satisfies AuditSink;
  const gateway = {
    connect: vi.fn(),
    close: vi.fn(),
    status: vi.fn(() =>
      options.statusThrows
        ? Promise.reject(new Error('secret status'))
        : Promise.resolve({
            state: options.disconnected ? ('disconnected' as const) : ('connected' as const),
            connectionGeneration: 1,
          }),
    ),
    browse: vi.fn(),
    read: vi.fn(),
    readMany: vi.fn(),
    getNodeMetadata: vi.fn(),
    writeNative: vi.fn(() =>
      options.throws
        ? Promise.reject(new Error('secret endpoint\nstack'))
        : Promise.resolve(options.result ?? { kind: 'operation' as const, statusCode: good }),
    ),
  } satisfies OpcUaGateway;
  return { records, auditSink, gateway, append };
}
async function connect(fixture: ReturnType<typeof setup>) {
  const server = createMcpServer({ config, configHash: '0123456789abcdef', ...fixture });
  const client = new Client({ name: 'native-write-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
async function call(client: Client, input: Record<string, unknown> = args) {
  const response = await client.callTool({ name: 'write_node', arguments: input });
  expect(response.isError).toBe(false);
  const content = response.content as { type: string; text?: unknown }[];
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== 'text' ||
    typeof content[0].text !== 'string'
  )
    throw new Error('Expected one text content');
  return JSON.parse(content[0].text) as {
    ok: boolean;
    attemptId: string;
    mutation: {
      outcome: string;
      error?: { code: string; statusCode?: unknown };
      statusCode?: unknown;
    };
    audit: { outcome: string; recordIds: string[] };
  };
}

describe('write_node MCP contract', () => {
  it('registers the closed required structural schema and only native mutation', async () => {
    const f = setup();
    const { client, close } = await connect(f);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'browse_node',
        'read_node',
        'read_nodes',
        'write_node',
      ]);
      const tool = tools.find((item) => item.name === 'write_node');
      expect(tool?.annotations).toEqual({
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tool?.inputSchema).toEqual({
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          dataType: { type: 'string' },
          value: {},
          reason: { type: 'string' },
        },
        required: ['nodeId', 'dataType', 'value'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      });
      for (const input of [
        { nodeId: 'i=1', dataType: 'Boolean' },
        { ...args, extra: 1 },
        { ...args, nodeId: 1 },
      ])
        expect((await client.callTool({ name: 'write_node', arguments: input })).isError).toBe(
          true,
        );
      expect(f.append).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it('appends correlated intent and completion and dispatches once without reads', async () => {
    const f = setup();
    const { client, close } = await connect(f);
    try {
      const result = await call(client);
      expect(result).toEqual({
        ok: true,
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        mutation: { outcome: 'accepted', statusCode: good },
        audit: { outcome: 'recorded', recordIds: f.records.map((r) => r.id) },
      });
      expect(f.records).toHaveLength(2);
      expect(new Set([result.attemptId, ...f.records.map((r) => r.id)]).size).toBe(3);
      expect(f.records[0]).toEqual({
        id: expect.any(String) as unknown,
        attemptId: result.attemptId,
        timestamp: expect.any(String) as unknown,
        configHash: '0123456789abcdef',
        event: 'write.intent',
        nodeId: 'ns=2;s=Motor;Speed',
        dataType: 'Boolean',
        requestedValue: true,
        reason: 'ok',
        mutation: { outcome: 'pending' },
      });
      expect(f.records[1]).toEqual({
        ...f.records[0],
        id: f.records[1]?.id,
        timestamp: f.records[1]?.timestamp,
        event: 'write.completion',
        mutation: result.mutation,
      });
      expect(f.gateway.writeNative).toHaveBeenCalledOnce();
      expect(f.gateway.writeNative).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'ns=2;s=Motor;Speed',
          namespace: 2,
          type: 'STRING',
          value: 'Motor;Speed',
        }),
        'Boolean',
        true,
      );
      expect(f.gateway.read).not.toHaveBeenCalled();
      expect(f.gateway.readMany).not.toHaveBeenCalled();
      expect(f.gateway.getNodeMetadata).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it.each([
    [{ ...args, nodeId: 'bad', dataType: 'bad', value: null, reason: '' }, 'invalid_node_id', {}],
    [
      { ...args, dataType: 'Nope', value: { secret: 'no' } },
      'unsupported_data_type',
      { nodeId: 'ns=2;s=Motor;Speed', reason: 'ok' },
    ],
    [
      { ...args, value: [1] },
      'invalid_value',
      { nodeId: 'ns=2;s=Motor;Speed', dataType: 'Boolean', reason: 'ok' },
    ],
    [
      { ...args, reason: 'four' },
      'invalid_reason',
      { nodeId: 'ns=2;s=Motor;Speed', dataType: 'Boolean', requestedValue: true },
    ],
    [
      { ...args, nodeId: 'x'.repeat(4097) },
      'node_id_too_long',
      { dataType: 'Boolean', requestedValue: true, reason: 'ok' },
    ],
    [{ ...args, dataType: 'Byte', value: 256 }, 'value_out_of_range', { dataType: 'Byte' }],
    [
      { ...args, dataType: 'String', value: 'x'.repeat(4097) },
      'value_too_long',
      { dataType: 'String' },
    ],
  ])('records bounded invalid preflight %#', async (input, code, fields) => {
    const f = setup();
    const { client, close } = await connect(f);
    try {
      const result = await call(client, input);
      expect(result).toMatchObject({
        ok: false,
        mutation: { outcome: 'not_attempted', error: { code } },
        audit: { outcome: 'recorded', recordIds: [expect.any(String)] },
      });
      expect(f.records).toHaveLength(1);
      expect(f.records[0]).toMatchObject({ event: 'write.preflight', ...fields });
      expect(f.gateway.writeNative).not.toHaveBeenCalled();
      expect(f.auditSink.health).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it.each([
    { health: 'bad' as const },
    { health: 'throw' as const },
    { disconnected: true },
    { statusThrows: true },
  ])('records preflight on failed gates %#', async (options) => {
    const f = setup(options);
    const { client, close } = await connect(f);
    try {
      const result = await call(client);
      expect(result).toMatchObject({
        ok: false,
        mutation: {
          outcome: 'not_attempted',
          error: {
            code:
              ('disconnected' in options && options.disconnected) ||
              ('statusThrows' in options && options.statusThrows)
                ? 'disconnected'
                : 'audit_unavailable',
          },
        },
        audit: { outcome: 'recorded' },
      });
      expect(f.records[0]?.event).toBe('write.preflight');
      expect(f.gateway.writeNative).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
  it('reports preflight append failure without exposing invalid fields', async () => {
    const f = setup({ failAppend: 1 });
    const { client, close } = await connect(f);
    try {
      const result = await call(client, {
        ...args,
        nodeId: 'bad',
        value: { secret: 'hidden' },
        reason: '',
      });
      expect(result).toMatchObject({
        mutation: { outcome: 'not_attempted', error: { code: 'invalid_node_id' } },
        audit: { outcome: 'failed', recordIds: [], error: { code: 'audit_unavailable' } },
      });
      expect(f.append).toHaveBeenCalledOnce();
      expect(f.gateway.writeNative).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('hidden');
    } finally {
      await close();
    }
  });
  it('validates reason by Unicode scalar values and rejects unpaired surrogates', async () => {
    const f = setup();
    const { client, close } = await connect(f);
    try {
      expect((await call(client, { ...args, reason: '\u{1F600}\u{1F600}\u{1F600}' })).ok).toBe(
        true,
      );
      expect(await call(client, { ...args, reason: '\ud800' })).toMatchObject({
        mutation: { error: { code: 'invalid_reason' } },
      });
      expect(f.records.at(-1)).not.toHaveProperty('reason');
      expect(f.gateway.writeNative).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });
  it('fails closed if intent append fails after healthy probe', async () => {
    const f = setup({ failAppend: 1 });
    const { client, close } = await connect(f);
    try {
      const result = await call(client);
      expect(result).toMatchObject({
        ok: false,
        mutation: { outcome: 'not_attempted', error: { code: 'audit_unavailable' } },
        audit: { outcome: 'failed', recordIds: [], error: { code: 'audit_unavailable' } },
      });
      expect(f.append).toHaveBeenCalledOnce();
      expect(f.gateway.writeNative).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      await close();
    }
  });
  it.each([
    [{ kind: 'operation' as const, statusCode: bad }, 'rejected', 'opcua_write_rejected', bad],
    [
      { kind: 'operation' as const, statusCode: uncertain },
      'unknown',
      'write_outcome_unknown',
      uncertain,
    ],
    [
      { kind: 'operation' as const, statusCode: reserved },
      'unknown',
      'write_outcome_unknown',
      reserved,
    ],
    [{ kind: 'operation' as const }, 'unknown', 'write_outcome_unknown', undefined],
    [{ kind: 'service_error' as const, statusCode: bad }, 'unknown', 'opcua_service_error', bad],
    [{ kind: 'service_error' as const }, 'unknown', 'opcua_service_error', undefined],
  ])(
    'classifies exact numeric status and records completion %#',
    async (writeResult, outcome, code, statusCode) => {
      const f = setup({ result: writeResult });
      const { client, close } = await connect(f);
      try {
        const result = await call(client);
        expect(result).toMatchObject({
          ok: false,
          mutation: { outcome, error: { code, ...(statusCode ? { statusCode } : {}) } },
          audit: { outcome: 'recorded' },
        });
        if (!statusCode) expect(result.mutation).not.toHaveProperty('error.statusCode');
        if (outcome === 'rejected') expect(result.mutation.statusCode).toEqual(statusCode);
        expect(f.records[1]?.mutation).toEqual(result.mutation);
        expect(f.gateway.writeNative).toHaveBeenCalledOnce();
      } finally {
        await close();
      }
    },
  );
  it.each([
    { result: { kind: 'operation' as const, statusCode: good }, outcome: 'accepted' },
    { result: { kind: 'operation' as const, statusCode: bad }, outcome: 'rejected' },
    { throws: true, outcome: 'unknown' },
  ])('preserves $outcome when completion append fails', async ({ outcome, ...options }) => {
    const f = setup({ ...options, failAppend: 2 });
    const { client, close } = await connect(f);
    try {
      const result = await call(client);
      expect(result).toMatchObject({
        ok: false,
        mutation: { outcome },
        audit: {
          outcome: 'failed',
          recordIds: [f.records[0]?.id],
          error: { code: 'audit_unavailable' },
        },
      });
      expect(f.gateway.writeNative).toHaveBeenCalledOnce();
      expect(f.append).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      await close();
    }
  });
  it('attempts completion after client cancellation once dispatch has begun', async () => {
    const f = setup();
    const { client, close } = await connect(f);
    let finish: ((result: NativeWriteResult) => void) | undefined;
    f.gateway.writeNative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const abort = new AbortController();
    try {
      const pending = client
        .callTool({ name: 'write_node', arguments: args }, undefined, { signal: abort.signal })
        .catch(() => undefined);
      await vi.waitFor(() => expect(f.gateway.writeNative).toHaveBeenCalledOnce());
      abort.abort();
      if (!finish) throw new Error('Dispatch did not start');
      finish({ kind: 'operation', statusCode: good });
      await pending;
      await vi.waitFor(() => expect(f.records).toHaveLength(2));
      expect(f.records[1]).toMatchObject({
        event: 'write.completion',
        mutation: { outcome: 'accepted', statusCode: good },
      });
      expect(f.gateway.writeNative).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });
  it('attempts completion on exception without leaking the exception', async () => {
    const f = setup({ throws: true });
    const { client, close } = await connect(f);
    try {
      const result = await call(client);
      expect(result).toMatchObject({
        mutation: { outcome: 'unknown', error: { code: 'write_outcome_unknown' } },
        audit: { outcome: 'recorded' },
      });
      expect(f.records[1]?.mutation).toEqual(result.mutation);
      expect(JSON.stringify(f.records)).not.toContain('secret');
      expect(f.gateway.writeNative).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });
});
