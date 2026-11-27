import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  NodeOpcUaGateway,
  type OpcUaClientLike,
  type OpcUaSessionLike,
} from '../../src/opcua/node-opcua-gateway.js';
import { parseNativeNodeId } from '../../src/opcua/native-encoding.js';
import { OpcUaStatusError } from '../../src/opcua/status-code.js';

const good = { value: 0, name: 'Good' };
const bad = { value: 0x801f0000, name: 'Good' };
const uncertain = { value: 0x40000000, name: 'Bad' };
const response = (status: unknown, results: unknown[] = []) => ({
  responseHeader: { serviceResult: status },
  results,
});

async function connected(session: OpcUaSessionLike) {
  const client: OpcUaClientLike = {
    connect: () => Promise.resolve(),
    createSession: () => Promise.resolve(session),
    disconnect: () => Promise.resolve(),
  };
  const gateway = new NodeOpcUaGateway({
    connection: {
      endpointUrl: 'opc.tcp://example.invalid:4840',
      securityMode: 'None',
      securityPolicy: 'None',
      auth: { type: 'anonymous' },
    },
    clientFactory: () => client,
  });
  await gateway.connect();
  await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'));
  return gateway;
}

describe('gateway status boundaries', () => {
  it('rejects bad, reserved and missing read status; preserves uncertain usable data', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: bad, value: { value: 1 } })
      .mockResolvedValueOnce({ statusCode: { value: 0xc0000000, name: 'Good' } })
      .mockResolvedValueOnce({ value: { value: 2 } })
      .mockResolvedValueOnce({ statusCode: uncertain, value: { value: 3 } });
    const gateway = await connected({ close: () => Promise.resolve(), read });
    await expect(gateway.read('i=1')).rejects.toMatchObject({
      statusCode: { value: 0x801f0000, hex: '0x801f0000', name: 'Good' },
    });
    await expect(gateway.read('i=1')).rejects.toBeInstanceOf(OpcUaStatusError);
    await expect(gateway.read('i=1')).rejects.toBeInstanceOf(OpcUaStatusError);
    await expect(gateway.read('i=1')).resolves.toMatchObject({
      value: 3,
      statusCode: { value: 0x40000000, hex: '0x40000000', name: 'Bad' },
    });
    await gateway.close();
  });
  it('rejects browse bad or missing statuses and preserves service faults on read and browse', async () => {
    const fault = Object.assign(new Error('sensitive'), { response: response(bad) });
    const browse = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: bad, references: [{ nodeId: 'i=2' }] })
      .mockResolvedValueOnce({ references: [] })
      .mockRejectedValueOnce(fault);
    const gateway = await connected({
      close: () => Promise.resolve(),
      browse,
      read: () => Promise.reject(fault),
    });
    for (let i = 0; i < 3; i++)
      await expect(gateway.browse('i=1', 1)).rejects.toBeInstanceOf(OpcUaStatusError);
    await expect(gateway.read('i=1')).rejects.toMatchObject({
      message: 'OPC UA read service failed.',
      statusCode: { value: bad.value },
    });
    await gateway.close();
    const metadataGateway = await connected({
      close: () => Promise.resolve(),
      browse: () => Promise.reject(fault),
      read: () => Promise.reject(fault),
    });
    await expect(metadataGateway.getNodeMetadata('i=1')).resolves.toMatchObject({
      attributeStatusCodes: { browse: { value: bad.value }, nodeId: { value: bad.value } },
    });
    await metadataGateway.close();
  });
  it('returns exact native operation and service statuses without public write', async () => {
    const transaction = vi
      .fn()
      .mockImplementationOnce((_request, cb: (err: unknown, result: unknown) => void) =>
        cb(null, response(good, [bad])),
      )
      .mockImplementationOnce((_request, cb: (err: unknown, result: unknown) => void) =>
        cb(null, response(good, [])),
      )
      .mockImplementationOnce((_request, cb: (err: unknown, result: unknown) => void) =>
        cb(new Error('fault'), response(bad)),
      )
      .mockImplementationOnce((_request, cb: (err: unknown) => void) =>
        cb(Object.assign(new Error('fault'), { response: response(bad) })),
      );
    const write = vi.fn();
    const gateway = await connected({
      close: () => Promise.resolve(),
      write,
      _performMessageTransaction: transaction,
    });
    const node = parseNativeNodeId('ns=2;s=a;\nb');
    await expect(gateway.writeNative(node, 'String', 'x')).resolves.toEqual({
      kind: 'operation',
      statusCode: { value: bad.value, hex: '0x801f0000', name: 'Good' },
    });
    await expect(gateway.writeNative(node, 'String', 'x')).resolves.toEqual({ kind: 'operation' });
    for (let i = 0; i < 2; i++)
      await expect(gateway.writeNative(node, 'String', 'x')).resolves.toEqual({
        kind: 'service_error',
        statusCode: { value: bad.value, hex: '0x801f0000', name: 'Good' },
      });
    const request = transaction.mock.calls[0]?.[0] as {
      nodesToWrite: { nodeId: { namespace: number; value: unknown } }[];
    };
    expect(request.nodesToWrite[0]?.nodeId).toMatchObject({ namespace: 2, value: 'a;\nb' });
    expect(write).not.toHaveBeenCalled();
    await gateway.close();
  }, 60_000);
  it('dispatches every parsed NodeId kind without SDK string reparsing', async () => {
    const transaction = vi.fn((_request: unknown, cb: (error: unknown, result: unknown) => void) =>
      cb(null, response(good, [good])),
    );
    const gateway = await connected({
      close: () => Promise.resolve(),
      _performMessageTransaction: transaction,
    });
    for (const text of [
      'ns=65535;i=4294967295',
      'ns=2;s=a;\n😀',
      'g=abcdef00-1234-abcd-9876-abcdefabcdef',
      'b=AA==',
      'b=',
    ]) {
      const parsed = parseNativeNodeId(text);
      await gateway.writeNative(parsed, 'Boolean', true);
      const request = transaction.mock.lastCall?.[0] as {
        nodesToWrite: { nodeId: { identifierType: number; namespace: number; value: unknown } }[];
      };
      const id = request.nodesToWrite[0]?.nodeId;
      expect(id?.namespace).toBe(parsed.namespace);
      expect(id?.value).toEqual(
        parsed.type === 'GUID' ? (parsed.value as string).toUpperCase() : parsed.value,
      );
    }
    await gateway.close();
  });
  it('validates forged node and scalar inputs before dispatch', async () => {
    const transaction = vi.fn();
    const gateway = await connected({
      close: () => Promise.resolve(),
      _performMessageTransaction: transaction,
    });
    await expect(
      gateway.writeNative({ ...parseNativeNodeId('i=1'), text: 'i=1x' }, 'Boolean', true),
    ).rejects.toMatchObject({ code: 'invalid_node_id' });
    await expect(
      gateway.writeNative(parseNativeNodeId('i=1'), 'UInt32', 1.5),
    ).rejects.toMatchObject({ code: 'value_out_of_range' });
    expect(transaction).not.toHaveBeenCalled();
    await gateway.close();
  });
  it('fails closed if private single-dispatch seam is unavailable', async () => {
    const write = vi.fn();
    const gateway = await connected({ close: () => Promise.resolve(), write });
    await expect(gateway.writeNative(parseNativeNodeId('i=1'), 'Boolean', true)).rejects.toThrow(
      'Single-dispatch',
    );
    expect(write).not.toHaveBeenCalled();
    await gateway.close();
  });
  it('uses the installed real session private path once on BadSessionIdInvalid, even while reconnecting', async () => {
    const require = createRequire(import.meta.url);
    const sessionModule = require('node-opcua-client/dist/private/client_session_impl.js') as {
      ClientSessionImpl: new (client: unknown) => OpcUaSessionLike;
    };
    const transport = vi.fn((_request: unknown, cb: (error: unknown) => void) =>
      cb(
        Object.assign(new Error('BadSessionIdInvalid'), {
          response: response({ value: 0x80250000, name: 'BadSessionIdInvalid' }),
        }),
      ),
    );
    const session = new sessionModule.ClientSessionImpl({
      _secureChannel: { isOpened: () => true },
      isReconnecting: true,
      performMessageTransaction: transport,
    });
    session.close = () => Promise.resolve();
    const gateway = await connected(session);
    await expect(gateway.writeNative(parseNativeNodeId('i=1'), 'Boolean', true)).resolves.toEqual({
      kind: 'service_error',
      statusCode: { value: 0x80250000, hex: '0x80250000', name: 'BadSessionIdInvalid' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    await gateway.close();
  });
});
