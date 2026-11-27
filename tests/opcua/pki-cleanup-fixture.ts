import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { NodeOpcUaGateway } from '../../src/opcua/node-opcua-gateway.js';

const require = createRequire(import.meta.url);
interface Manager {
  state: number;
  referenceCounter: number;
  rootDir: string;
  automaticallyAcceptUnknownCertificate: boolean;
  dispose(): Promise<void>;
}
const sdk = require('node-opcua') as {
  OPCUAClient: { create(options: { clientCertificateManager: Manager }): unknown };
  OPCUACertificateManager: new (options: Record<string, unknown>) => Manager;
};
const pki = require('node-opcua-pki') as {
  CertificateManager: { checkAllDisposed(): void; disposeAll(): Promise<void> };
};
const root = process.argv[2];
assert(root);
const managers: Manager[] = [];
const statesAtDispose: number[] = [];
const countersAtDispose: number[] = [];
const create = sdk.OPCUAClient.create.bind(sdk.OPCUAClient);
sdk.OPCUAClient.create = (options) => {
  const manager = options.clientCertificateManager;
  managers.push(manager);
  const dispose = manager.dispose.bind(manager);
  manager.dispose = async () => {
    statesAtDispose.push(manager.state);
    countersAtDispose.push(manager.referenceCounter);
    await dispose();
  };
  return create(options);
};
const connection = {
  endpointUrl: 'opc.tcp://127.0.0.1:1',
  securityMode: 'None' as const,
  securityPolicy: 'None',
  auth: { type: 'anonymous' as const },
};
const gateway = new NodeOpcUaGateway({
  connection: { ...connection, securityMode: 'Sign', securityPolicy: 'Basic256Sha256' },
  reconnect: { initialDelayMs: 200, maxDelayMs: 200 },
});
const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for connection cleanup');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  await gateway.connect();
  await waitFor(() => managers.length >= 3 && managers.every((manager) => manager.state === 4));
  await gateway.close();
  assert(managers.length >= 3);
  assert(
    managers.every((manager) => {
      const path = relative(root, manager.rootDir);
      return path !== '' && !path.startsWith('..') && !isAbsolute(path);
    }),
  );
  assert(statesAtDispose.filter((state) => state === 2).length >= 6);
  assert(countersAtDispose.some((counter) => counter >= 2));
  pki.CertificateManager.checkAllDisposed();

  const injected = new sdk.OPCUACertificateManager({
    rootFolder: join(root, 'injected'),
    automaticallyAcceptUnknownCertificate: false,
  });
  const injectedGateway = new NodeOpcUaGateway({ connection, certificateManager: injected });
  try {
    await injectedGateway.connect();
    await waitFor(async () => (await injectedGateway.status()).lastError !== undefined);
    await injectedGateway.close();
    assert.equal(injected.state, 2);
    assert.throws(() => pki.CertificateManager.checkAllDisposed());
  } finally {
    await injectedGateway.close();
    while (injected.referenceCounter > 0) await injected.dispose();
    await injected.dispose();
  }
  pki.CertificateManager.checkAllDisposed();
} finally {
  await gateway.close();
  await pki.CertificateManager.disposeAll();
}
