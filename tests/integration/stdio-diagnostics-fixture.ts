import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCliProgram } from '../../src/cli/index.js';

await createCliProgram().parseAsync([
  'node',
  'opcua-mcp',
  'serve',
  '--config',
  process.argv[2] ?? '',
]);

if (process.env['VERBOSE'] !== undefined || process.env['NODEOPCUAPKIDEBUG'] !== undefined) {
  throw new Error('Unsafe SDK PKI debug modes were not disabled');
}
const debug = createRequire(import.meta.url)('node-opcua-debug') as {
  setLogLevel(level: number): void;
  setDebugFlag(path: string, enabled: boolean): void;
  make_debugLog: (path: string) => (...args: unknown[]) => void;
  make_warningLog: (path: string) => (...args: unknown[]) => void;
  make_errorLog: (path: string) => (...args: unknown[]) => void;
  make_traceLog: (path: string) => (...args: unknown[]) => void;
};
debug.setLogLevel(7);
debug.setDebugFlag('fixture', true);
for (const log of [
  debug.make_debugLog,
  debug.make_warningLog,
  debug.make_errorLog,
  debug.make_traceLog,
]) {
  log('fixture')('secret-value ns=9;s=secret-node', { password: 'secret-password' });
}
const { CertificateManager } = createRequire(import.meta.url)('node-opcua-pki') as {
  CertificateManager: new (options: object) => {
    verifyCertificateAsync(certificate: Buffer): Promise<string>;
    verifyCertificate(certificate: Buffer): Promise<string>;
  };
};
const manager = new CertificateManager({
  location: join(dirname(process.argv[2] ?? ''), 'fixture-pki'),
});
manager.verifyCertificateAsync = () => Promise.reject(new Error('secret-value ns=9;s=secret-node'));
if ((await manager.verifyCertificate(Buffer.from([1]))) !== 'BadCertificateInvalid') {
  throw new Error('Unexpected fixture certificate status');
}
console.log('secret-value ns=9;s=secret-node');
console.warn({ password: 'secret-password' });
console.error(new Error('secret-value'));
console.info('secret-value');
console.debug('secret-value');
console.trace('secret-value');
