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
        auth: { type: 'usernamePassword', username: '${OPCUA_USERNAME}', password: '${OPCUA_PASSWORD}' },
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

  it('reports sanitized connection failures, then reconnects with a new generation', async () => {
    vi.useFakeTimers();
    const failedClient = rejectingClient(Object.assign(new Error('connect failed\nsecret stack'), { code: 'ECONNREFUSED' }));
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
      lastError: { code: 'ECONNREFUSED', message: 'connect failed', at: '2026-07-05T00:00:01.000Z' },
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

function resolvedClient(): TestClient {
  const connect = vi.fn(() => Promise.resolve());
  const createSession = vi.fn(() => Promise.resolve({ close: () => Promise.resolve() }));
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
