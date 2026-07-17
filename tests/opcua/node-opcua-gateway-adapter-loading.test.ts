import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/schema.js';

vi.mock('node:module', () => ({
  createRequire: () => () => {
    throw new Error('node-opcua should not be loaded while mapping browse results');
  },
}));

const anonymousConnection: AppConfig['connection'] = {
  endpointUrl: 'opc.tcp://example.invalid:4840',
  securityMode: 'None',
  securityPolicy: 'None',
  auth: { type: 'anonymous' },
};

describe('NodeOpcUaGateway adapter loading', () => {
  it('maps built-in browse enums without loading node-opcua', async () => {
    const { NodeOpcUaGateway } = await import('../../src/opcua/node-opcua-gateway.js');
    const session = {
      close: () => Promise.resolve(),
      browse: () =>
        Promise.resolve({
          references: [
            {
              nodeId: 'ns=2;s=Timestamp',
              nodeClass: 0, // NodeClass.Unspecified
              dataType: 13, // DataType.DateTime
            },
          ],
        }),
    };
    const gateway = new NodeOpcUaGateway({
      connection: anonymousConnection,
      clientFactory: () => ({
        connect: () => Promise.resolve(),
        createSession: () => Promise.resolve(session),
        disconnect: () => Promise.resolve(),
      }),
    });

    await gateway.connect();
    await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'));

    await expect(gateway.browse('ns=2;s=Machine', 1)).resolves.toEqual([
      {
        nodeId: 'ns=2;s=Timestamp',
        nodeClass: 'Unspecified',
        dataType: 'DateTime',
      },
    ]);
  });
});
