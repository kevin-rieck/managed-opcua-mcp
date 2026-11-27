import { describe, expect, it, vi } from 'vitest';

interface MockManager {
  referenceCounter: number;
  dispose: () => Promise<void>;
}

const sdk = vi.hoisted(() => {
  const manager = vi.fn((): MockManager => {
    const instance: MockManager = {
      referenceCounter: 0,
      dispose: vi.fn(() => {
        if (instance.referenceCounter > 0) instance.referenceCounter--;
        return Promise.resolve();
      }),
    };
    return instance;
  });
  const disconnect = vi.fn(() => Promise.resolve());
  const session: { close: () => Promise<void>; performMessageTransaction?: () => void } = {
    close: vi.fn(() => Promise.resolve()),
    performMessageTransaction: () => undefined,
  };
  const create = vi.fn(() => ({
    connect: () => Promise.resolve(),
    disconnect,
    createSession: () => Promise.resolve(session),
  }));
  return { manager, create, session, disconnect };
});
vi.mock('node:module', () => ({
  createRequire: () => () => ({
    OPCUACertificateManager: sdk.manager,
    setDebugLogger: vi.fn(),
    setWarningLogger: vi.fn(),
    setErrorLogger: vi.fn(),
    setTraceLogger: vi.fn(),
    OPCUAClient: { create: sdk.create },
    MessageSecurityMode: { None: 1, Sign: 2, SignAndEncrypt: 3 },
    SecurityPolicy: { None: 'none-uri', Basic256Sha256: 'secure-uri', Invalid: 'invalid' },
  }),
}));

describe('client certificate trust configuration', () => {
  it('explicitly disables trust-on-first-use and rejects invalid mode/policy combinations', async () => {
    const { NodeOpcUaGateway } = await import('../../src/opcua/node-opcua-gateway.js');
    const connection = {
      endpointUrl: 'opc.tcp://example.invalid:4840',
      securityMode: 'Sign' as const,
      securityPolicy: 'Basic256Sha256',
      auth: { type: 'anonymous' as const },
    };
    const gateway = new NodeOpcUaGateway({ connection });
    await gateway.connect();
    await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'));
    expect(sdk.manager).toHaveBeenCalledWith({ automaticallyAcceptUnknownCertificate: false });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        securityMode: 2,
        securityPolicy: 'secure-uri',
        clientCertificateManager: sdk.manager.mock.results[0]?.value as unknown,
      }),
    );
    await gateway.close();
    sdk.create.mockClear();
    for (const invalid of [
      { ...connection, securityPolicy: 'NoSuchPolicy' },
      { ...connection, securityPolicy: 'None' },
      { ...connection, securityMode: 'None' as const },
    ]) {
      const rejected = new NodeOpcUaGateway({ connection: invalid });
      await rejected.connect();
      await vi.waitFor(async () =>
        expect((await rejected.status()).lastError?.message).toBe(
          'Invalid OPC UA security mode or policy.',
        ),
      );
      await rejected.close();
    }
    const insecureManager = new NodeOpcUaGateway({
      connection,
      certificateManager: { automaticallyAcceptUnknownCertificate: true },
    });
    await insecureManager.connect();
    await vi.waitFor(async () =>
      expect((await insecureManager.status()).lastError?.message).toBe(
        'OPC UA certificate manager must reject unknown certificates.',
      ),
    );
    await insecureManager.close();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('releases an owned manager when disconnect or client creation fails', async () => {
    const { NodeOpcUaGateway } = await import('../../src/opcua/node-opcua-gateway.js');
    const connection = {
      endpointUrl: 'opc.tcp://example.invalid:4840',
      securityMode: 'None' as const,
      securityPolicy: 'None',
      auth: { type: 'anonymous' as const },
    };
    sdk.create.mockImplementationOnce(() => {
      const owned = sdk.manager.mock.results.at(-1)?.value as MockManager | undefined;
      if (owned) owned.referenceCounter = 1;
      return {
        connect: () => Promise.resolve(),
        disconnect: vi.fn(() => Promise.reject(new Error('disconnect failed'))),
        createSession: () => Promise.resolve(sdk.session),
      };
    });
    const gateway = new NodeOpcUaGateway({ connection });
    await gateway.connect();
    await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'));
    const owned = sdk.manager.mock.results.at(-1)?.value as MockManager | undefined;
    await gateway.close();
    await gateway.close();
    expect(owned?.dispose).toHaveBeenCalledTimes(2);

    sdk.create.mockImplementationOnce(() => {
      const failed = sdk.manager.mock.results.at(-1)?.value as MockManager | undefined;
      if (failed) failed.referenceCounter = 1;
      throw new Error('create failed');
    });
    const failedGateway = new NodeOpcUaGateway({ connection });
    await failedGateway.connect();
    await vi.waitFor(() => {
      const failed = sdk.manager.mock.results.at(-1)?.value as MockManager | undefined;
      expect(failed?.dispose).toHaveBeenCalledTimes(2);
    });
    await failedGateway.close();
  });

  it('fails closed when the installed client session lacks the response seam', async () => {
    const { NodeOpcUaGateway } = await import('../../src/opcua/node-opcua-gateway.js');
    delete sdk.session.performMessageTransaction;
    const gateway = new NodeOpcUaGateway({
      connection: {
        endpointUrl: 'opc.tcp://example.invalid:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        auth: { type: 'anonymous' },
      },
    });
    try {
      await gateway.connect();
      await vi.waitFor(async () =>
        expect((await gateway.status()).lastError?.message).toBe(
          'OPC UA service response seam is unavailable.',
        ),
      );
      expect((await gateway.status()).state).toBe('disconnected');
      expect(sdk.session.close).toHaveBeenCalled();
    } finally {
      await gateway.close();
    }
  });
});
