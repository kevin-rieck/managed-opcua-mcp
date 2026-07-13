import { describe, expect, it, vi } from 'vitest';
import { NodeOpcUaGateway, type OpcUaClientLike } from '../../src/opcua/node-opcua-gateway.js';
import type { AppConfig } from '../../src/config/schema.js';

const anonymousConnection: AppConfig['connection'] = {
  endpointUrl: 'opc.tcp://example.invalid:4840',
  securityMode: 'None',
  securityPolicy: 'None',
  auth: { type: 'anonymous' },
};

describe('NodeOpcUaGateway connection lifecycle', () => {
  it('starts connecting without blocking and reports a connected session with health timestamp', async () => {
    const client = pendingClient();
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => client,
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });

    await gateway.connect();
    expect((await gateway.status()).state).toBe('connecting');

    await client.resolveConnect();

    expect(client.connectMock).toHaveBeenCalledWith('opc.tcp://example.invalid:4840');
    expect(client.createSessionMock).toHaveBeenCalledWith(undefined);
    expect(await gateway.status()).toMatchObject({
      state: 'connected',
      lastSuccessfulHealthCheckAt: '2026-07-05T00:00:00.000Z',
      connectionGeneration: 1,
    });
  });

  it('connects with configured security and username/password environment auth', async () => {
    vi.stubEnv('OPCUA_USERNAME', 'operator');
    vi.stubEnv('OPCUA_PASSWORD', 'secret');
    const client = resolvedClient();
    const clientFactory = vi.fn(() => client);
    const gateway = new NodeOpcUaGateway({
      connection: {
        endpointUrl: 'opc.tcp://secure.example.invalid:4840',
        securityMode: 'Sign',
        securityPolicy: 'Basic256Sha256',
        auth: {
          type: 'usernamePassword',
          username: '${OPCUA_USERNAME}',
          password: '${OPCUA_PASSWORD}',
        },
      },
      clientFactory,
    });

    await gateway.connect();
    await flushPromises();

    expect(clientFactory).toHaveBeenCalledWith({
      securityMode: 'Sign',
      securityPolicy: 'Basic256Sha256',
    });
    expect(client.createSessionMock).toHaveBeenCalledWith({
      type: 'UserName',
      userName: 'operator',
      password: 'secret',
    });

    vi.unstubAllEnvs();
  });

  it('browses connected sessions through forward hierarchical references', async () => {
    const session = {
      close: () => Promise.resolve(),
      browse: vi.fn(() =>
        Promise.resolve({
          references: [
            {
              nodeId: { toString: () => 'ns=2;s=Machine.Motor' },
              browseName: { toString: () => '2:Motor' },
              displayName: { text: 'Motor' },
              nodeClass: 1, // NodeClass.Object
              dataType: 11, // DataType.Double
            },
          ],
        }),
      ),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.browse('ns=2;s=Machine', 1)).resolves.toEqual([
      {
        nodeId: 'ns=2;s=Machine.Motor',
        browseName: '2:Motor',
        displayName: 'Motor',
        nodeClass: 'Object',
        dataType: 'Double',
      },
    ]);
    expect(session.browse).toHaveBeenCalledWith({
      nodeId: 'ns=2;s=Machine',
      browseDirection: 'Forward',
      referenceTypeId: 'HierarchicalReferences',
      includeSubtypes: true,
      resultMask: 63,
    });
  });

  it('inspects Node metadata without reading the current value', async () => {
    const read = vi.fn((description: { attributeId: number }) => {
      const attributes: Record<number, unknown> = {
        1: { value: { value: 'ns=2;s=Machine.Temperature' }, statusCode: { name: 'Good' } },
        2: { value: { value: 2 }, statusCode: { name: 'Good' } },
        14: { value: { value: 11 }, statusCode: { name: 'Good' } },
        15: { value: { value: -1 }, statusCode: { name: 'Good' } },
        17: { value: { value: 3 }, statusCode: { name: 'Good' } },
        18: { value: { value: 1 }, statusCode: { name: 'Good' } },
      };
      return Promise.resolve(
        attributes[description.attributeId] ?? { statusCode: { name: 'BadAttributeIdInvalid' } },
      );
    });
    const session = {
      close: () => Promise.resolve(),
      browse: vi.fn(() => Promise.resolve({ references: [], statusCode: { name: 'Good' } })),
      read,
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.getNodeMetadata('ns=2;s=Machine.Temperature')).resolves.toEqual({
      exists: true,
      browseable: true,
      readable: true,
      writable: false,
      dataType: 'Double',
    });
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ attributeId: 13 }));
  });

  it('maps writable session access from OPC UA UserAccessLevel metadata', async () => {
    const session = {
      close: () => Promise.resolve(),
      browse: vi.fn(() => Promise.resolve({ references: [], statusCode: { name: 'Good' } })),
      read: vi.fn((description: { attributeId: number }) =>
        Promise.resolve({
          value: {
            value:
              description.attributeId === 1
                ? 'ns=2;s=Machine.SpeedSetpoint'
                : description.attributeId === 14
                  ? 11
                  : 3,
          },
          statusCode: { name: 'Good' },
        }),
      ),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.getNodeMetadata('ns=2;s=Machine.SpeedSetpoint')).resolves.toEqual({
      exists: true,
      browseable: true,
      readable: true,
      writable: true,
      dataType: 'Double',
    });
  });

  it('preserves partial metadata when expected OPC UA attribute reads fail', async () => {
    const session = {
      close: () => Promise.resolve(),
      browse: vi.fn(() =>
        Promise.resolve({ references: [], statusCode: { name: 'BadUserAccessDenied' } }),
      ),
      read: vi.fn((description: { attributeId: number }) =>
        Promise.resolve(
          description.attributeId === 1
            ? { value: { value: 'ns=2;s=Machine' }, statusCode: { name: 'Good' } }
            : { statusCode: { name: 'BadAttributeIdInvalid' } },
        ),
      ),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.getNodeMetadata('ns=2;s=Machine')).resolves.toEqual({
      exists: true,
      browseable: false,
    });
  });

  it('reads values from connected sessions with OPC UA status and timestamps', async () => {
    const session = {
      close: () => Promise.resolve(),
      read: vi.fn(() =>
        Promise.resolve({
          value: { dataType: 11 /* Double */, value: 72.5 },
          statusCode: { value: 0, name: 'Good' }, // node-opcua StatusCode is an object, but sometimes represented by its enum number or an object with name
          sourceTimestamp: new Date('2026-07-07T10:00:00.000Z'),
          serverTimestamp: new Date('2026-07-07T10:00:01.000Z'),
        }),
      ),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.read('ns=2;s=Machine.Temperature')).resolves.toEqual({
      nodeId: 'ns=2;s=Machine.Temperature',
      dataType: 'Double',
      value: 72.5,
      opcuaStatus: 'Good',
      sourceTimestamp: '2026-07-07T10:00:00.000Z',
      serverTimestamp: '2026-07-07T10:00:01.000Z',
    });
    expect(session.read).toHaveBeenCalledWith({
      nodeId: 'ns=2;s=Machine.Temperature',
      attributeId: 13,
    });
  });

  it('writes values through connected sessions', async () => {
    const session = {
      close: () => Promise.resolve(),
      write: vi.fn(() => Promise.resolve({ toString: () => 'Good' })),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => resolvedClient(session),
    });

    await gateway.connect();
    await flushPromises();

    await expect(gateway.write('ns=2;s=Machine.Enabled', 'Boolean', true)).resolves.toEqual({
      opcuaStatus: 'Good',
    });
    expect(session.write).toHaveBeenCalledWith({
      nodeId: 'ns=2;s=Machine.Enabled',
      attributeId: 13,
      value: { value: { dataType: 'Boolean', value: true } },
    });
  });

  it('reports sanitized connection failures, then reconnects with a new generation', async () => {
    vi.useFakeTimers();
    const failedClient = rejectingClient(
      Object.assign(new Error('connect failed\nsecret stack'), { code: 'ECONNREFUSED' }),
    );
    const connectedClient = resolvedClient();
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: vi.fn().mockReturnValueOnce(failedClient).mockReturnValueOnce(connectedClient),
      now: vi
        .fn()
        .mockReturnValueOnce(new Date('2026-07-05T00:00:01.000Z'))
        .mockReturnValueOnce(new Date('2026-07-05T00:00:02.000Z')),
      reconnect: { initialDelayMs: 100, maxDelayMs: 100 },
    });

    await gateway.connect();
    await flushPromises();

    expect(await gateway.status()).toMatchObject({
      state: 'disconnected',
      connectionGeneration: 0,
      lastError: {
        code: 'ECONNREFUSED',
        message: 'connect failed',
        at: '2026-07-05T00:00:01.000Z',
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(await gateway.status()).toMatchObject({
      state: 'connected',
      connectionGeneration: 1,
      lastSuccessfulHealthCheckAt: '2026-07-05T00:00:02.000Z',
    });
    expect((await gateway.status()).lastError).toBeUndefined();

    await gateway.close();
    vi.useRealTimers();
  });
});

type MockFunction = ReturnType<typeof vi.fn>;

type TestClient = OpcUaClientLike & {
  connectMock: MockFunction;
  createSessionMock: MockFunction;
};

function pendingClient(): TestClient & { resolveConnect: () => Promise<void> } {
  let releaseConnect: (() => void) | undefined;
  const connect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseConnect = resolve;
      }),
  );

  const createSession = vi.fn(() => Promise.resolve({ close: () => Promise.resolve() }));

  return {
    connect,
    connectMock: connect,
    createSession,
    createSessionMock: createSession,
    disconnect: vi.fn(() => Promise.resolve()),
    resolveConnect: async () => {
      if (releaseConnect === undefined) throw new Error('connect was not called');
      releaseConnect();
      await flushPromises();
    },
  };
}

function resolvedClient(
  session: Awaited<ReturnType<TestClient['createSession']>> = { close: () => Promise.resolve() },
): TestClient {
  const connect = vi.fn(() => Promise.resolve());
  const createSession = vi.fn(() => Promise.resolve(session));
  return {
    connect,
    connectMock: connect,
    createSession,
    createSessionMock: createSession,
    disconnect: vi.fn(() => Promise.resolve()),
  };
}

function rejectingClient(error: Error): TestClient {
  const connect = vi.fn(() => Promise.reject(error));
  const createSession = vi.fn(() => Promise.resolve({ close: () => Promise.resolve() }));
  return {
    connect,
    connectMock: connect,
    createSession,
    createSessionMock: createSession,
    disconnect: vi.fn(() => Promise.resolve()),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
