import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface Manager {
  verifyCertificate(certificate: Buffer): Promise<string>;
  rejectCertificate(certificate: Buffer): Promise<void>;
  trustCertificate(certificate: Buffer): Promise<void>;
  checkCertificate(certificate: Buffer): Promise<{ name: string }>;
  dispose(): Promise<void>;
}
const sdk = createRequire(import.meta.url)('node-opcua-certificate-manager') as {
  OPCUACertificateManager: new (options: {
    rootFolder: string;
    automaticallyAcceptUnknownCertificate: boolean;
  }) => Manager;
};

describe('installed OPC UA certificate manager', () => {
  it('rejects an untrusted server and does not auto-trust unknown revocation', async () => {
    const rootFolder = await mkdtemp(join(tmpdir(), 'opcua-trust-test-'));
    const manager = new sdk.OPCUACertificateManager({
      rootFolder,
      automaticallyAcceptUnknownCertificate: false,
    });
    try {
      const verify = vi
        .spyOn(manager, 'verifyCertificate')
        .mockResolvedValue('BadCertificateUntrusted');
      const reject = vi.spyOn(manager, 'rejectCertificate').mockResolvedValue();
      const trust = vi.spyOn(manager, 'trustCertificate').mockResolvedValue();
      expect((await manager.checkCertificate(Buffer.from([1, 2, 3]))).name).toBe(
        'BadCertificateUntrusted',
      );
      expect(reject).toHaveBeenCalledOnce();
      expect(trust).not.toHaveBeenCalled();
      verify.mockResolvedValue('BadCertificateRevocationUnknown');
      expect((await manager.checkCertificate(Buffer.from([1, 2, 3]))).name).toBe(
        'BadCertificateRevocationUnknown',
      );
      expect(trust).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      await rm(rootFolder, { recursive: true, force: true });
    }
  });
});
