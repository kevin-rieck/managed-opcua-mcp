import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../../src/cli/index.js';
import type {
  BrowseNodeResult,
  NodeMetadataResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
} from '../../src/opcua/gateway.js';
import { NodeOpcUaGateway, type OpcUaClientLike } from '../../src/opcua/node-opcua-gateway.js';

const configYaml = `
version: 2
connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: None
  securityPolicy: None
  auth:
    type: anonymous
read:
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
audit:
  file: ./audit.jsonl
`;

describe('CLI admin workflows', () => {
  it('doctor exits 0 with JSON success when local and online diagnostics pass', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      },
    });

    const result = await runCli(['doctor', '--config', configPath, '--format', 'json'], gateway);

    const output = asRecord(JSON.parse(result.stdout) as unknown);
    expect(result.exitCode).toBe(0);
    expect(output['ok']).toBe(true);
    expect(output['resultClass']).toBe('success');
    const localValidation = asRecord(output['localValidation']);
    expect(localValidation['ok']).toBe(true);
    expect(typeof localValidation['configHash']).toBe('string');
    expect(output['onlineDiagnostics']).toMatchObject({ state: 'valid', blockingErrors: [] });
    expect(gateway.connect).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(gateway.writeNative).not.toHaveBeenCalled();
    expect(gateway.read).not.toHaveBeenCalled();
    expect(gateway.readMany).not.toHaveBeenCalled();
    expect(gateway.browse).not.toHaveBeenCalled();
  });

  it('doctor uses real adapter metadata attributes without reading current Node values', async () => {
    const configPath = writeTempConfig(configYaml);
    const read = vi.fn((description: { nodeId: string; attributeId: number }) => {
      if (description.attributeId === 1) {
        return Promise.resolve({
          value: { value: description.nodeId },
          statusCode: { value: 0, name: 'Good' },
        });
      }
      if (description.attributeId === 14) {
        return Promise.resolve({ value: { value: 1 }, statusCode: { value: 0, name: 'Good' } });
      }
      if (description.attributeId === 15) {
        return Promise.resolve({ value: { value: -1 }, statusCode: { value: 0, name: 'Good' } });
      }
      if (description.attributeId === 18) {
        return Promise.resolve({ value: { value: 3 }, statusCode: { value: 0, name: 'Good' } });
      }
      return Promise.resolve({ statusCode: { value: 0x80350000, name: 'BadAttributeIdInvalid' } });
    });
    const session = {
      close: () => Promise.resolve(),
      browse: () => Promise.resolve({ references: [], statusCode: { value: 0, name: 'Good' } }),
      read,
    };
    const client: OpcUaClientLike = {
      connect: () => Promise.resolve(),
      createSession: () => Promise.resolve(session),
      disconnect: () => Promise.resolve(),
    };
    const gateway = new NodeOpcUaGateway({
      connection: {
        endpointUrl: 'opc.tcp://localhost:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        auth: { type: 'anonymous' },
      },
      clientFactory: () => client,
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      onlineDiagnostics: { state: 'valid' },
    });
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ attributeId: 13 }));
  });

  it('doctor returns expected metadata failures as structured diagnostics', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({});
    gateway.getNodeMetadata = vi.fn(() =>
      Promise.reject(new Error('BadUserAccessDenied\nprivate stack')),
    );

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_blocking_errors',
      onlineDiagnostics: {
        blockingErrors: [{ code: 'read_root_unavailable', message: 'BadUserAccessDenied' }],
      },
    });
  });

  it('doctor distinguishes Read Entry Point access denial from a missing Node', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': {
        exists: false,
        browseable: false,
        attributeStatuses: { nodeId: 'BadUserAccessDenied', browse: 'BadUserAccessDenied' },
      },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
        valueRank: -1,
      },
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      onlineDiagnostics: {
        blockingErrors: [
          {
            code: 'read_root_unavailable',
            nodeId: 'ns=2;s=Machine',
            evidence: {
              attributeStatuses: {
                nodeId: 'BadUserAccessDenied',
                browse: 'BadUserAccessDenied',
              },
            },
          },
        ],
      },
    });
  });

  it('doctor stops before online diagnostics when local validation fails', async () => {
    const configPath = writeTempConfig(`${configYaml}unexpectedField: true\n`);
    const gateway = fakeGateway({});

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'local_validation_failed',
      localValidation: { ok: false, errors: [{ code: 'unrecognized_keys', path: '(root)' }] },
    });
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('doctor exits 4 when online diagnostics are incomplete because the OPC UA Server is unavailable', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({}, [], {}, { state: 'reconnecting', connectionGeneration: 1 });

    const result = await runCli(
      ['doctor', '--config', configPath, '--online-timeout-ms', '0'],
      gateway,
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_diagnostics_unavailable',
      onlineDiagnostics: {
        state: 'pending',
        unavailableReasons: [{ code: 'online_validation_pending' }],
      },
    });
  });

  it('validate performs local validation without creating an OPC UA gateway', async () => {
    const configPath = writeTempConfig(configYaml);
    let exitCode = 0;
    let stdout = '';
    const program = createCliProgram({
      gatewayFactory: () => {
        throw new Error('validate must not create an OPC UA gateway');
      },
      stdout: (text) => {
        stdout += text;
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await program.parseAsync(['node', 'opcua-mcp', 'validate', '--config', configPath]);

    const output = asRecord(JSON.parse(stdout) as unknown);
    expect(exitCode).toBe(0);
    expect(output['ok']).toBe(true);
    expect(output['configHash']).toEqual(expect.any(String));
  });

  it('validate-config can include online validation output from a reachable OPC UA Server', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      },
    });

    const result = await runCli(['validate-config', '--config', configPath, '--online'], gateway);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      onlineValidation: { state: 'valid', reasons: [] },
    });
    expect(gateway.connect).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
  });
});

async function runCli(
  args: string[],
  gateway: OpcUaGateway,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  const program = createCliProgram({
    gatewayFactory: () => gateway,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(['node', 'opcua-mcp', ...args]);
  return { exitCode, stdout, stderr };
}

function writeTempConfig(contents: string): string {
  const dir = tempDir();
  const configPath = join(dir, 'config.yaml');
  // Test-owned temporary config path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(configPath, contents);
  return configPath;
}

function tempDir(): string {
  const dir = join(tmpdir(), `opcua-mcp-cli-${randomUUID()}`);
  // Test-owned temporary directory path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dir, { recursive: true });
  return dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected YAML document object.');
  }
  return value as Record<string, unknown>;
}

function fakeGateway(
  metadata: Record<string, NodeMetadataResult>,
  browseResults: BrowseNodeResult[] = [],
  readResults: Record<string, ReadValueResult> = {},
  status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 },
): OpcUaGateway & {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  browse: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  readMany: ReturnType<typeof vi.fn>;
  writeNative: ReturnType<typeof vi.fn>;
} {
  return {
    status: (): Promise<OpcUaStatus> => Promise.resolve(status),
    connect: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    browse: vi.fn(() => Promise.resolve(browseResults)),
    read: vi.fn((nodeId: string) => {
      const result = readResults[nodeId];
      if (result === undefined) return Promise.reject(new Error('not readable'));
      return Promise.resolve(result);
    }),
    readMany: vi.fn((nodeIds: string[]) =>
      Promise.all(
        nodeIds.map((nodeId) => Promise.resolve(readResults[nodeId] ?? { nodeId, value: null })),
      ),
    ),
    writeNative: vi.fn(() => Promise.resolve({ kind: 'operation' as const })),
    getNodeMetadata: (nodeId) => Promise.resolve(metadata[nodeId] ?? { exists: false }),
  };
}
