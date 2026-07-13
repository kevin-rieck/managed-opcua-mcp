import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
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
version: 1
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
controls:
  items:
    - name: motor_enabled
      description: Enables motor.
      nodeId: ns=2;s=Machine.MotorEnabled
      dataType: Boolean
      falseLabel: disabled
      trueLabel: enabled
      riskLevel: low
      riskNote: Can start motion.
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
    expect(output['warnings']).toEqual([]);
    expect(gateway.connect).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(gateway.write).not.toHaveBeenCalled();
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
          statusCode: { name: 'Good' },
        });
      }
      if (description.attributeId === 14) {
        return Promise.resolve({ value: { value: 1 }, statusCode: { name: 'Good' } });
      }
      if (description.attributeId === 15) {
        return Promise.resolve({ value: { value: -1 }, statusCode: { name: 'Good' } });
      }
      if (description.attributeId === 18) {
        return Promise.resolve({ value: { value: 3 }, statusCode: { name: 'Good' } });
      }
      return Promise.resolve({ statusCode: { name: 'BadAttributeIdInvalid' } });
    });
    const session = {
      close: () => Promise.resolve(),
      browse: () => Promise.resolve({ references: [], statusCode: { name: 'Good' } }),
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

  it('doctor reports a real adapter session without write access as a blocking diagnostic', async () => {
    const configPath = writeTempConfig(configYaml);
    const write = vi.fn(() => Promise.resolve({ name: 'Good' }));
    const session = {
      close: () => Promise.resolve(),
      browse: () => Promise.resolve({ references: [], statusCode: { name: 'Good' } }),
      read: (description: { nodeId: string; attributeId: number }) => {
        const value =
          description.attributeId === 1
            ? description.nodeId
            : description.attributeId === 15
              ? -1
              : 1;
        return Promise.resolve({ value: { value }, statusCode: { name: 'Good' } });
      },
      write,
    };
    const gateway = new NodeOpcUaGateway({
      connection: {
        endpointUrl: 'opc.tcp://localhost:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        auth: { type: 'anonymous' },
      },
      clientFactory: () => ({
        connect: () => Promise.resolve(),
        createSession: () => Promise.resolve(session),
        disconnect: () => Promise.resolve(),
      }),
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_blocking_errors',
      onlineDiagnostics: {
        state: 'invalid',
        blockingErrors: [
          {
            code: 'control_target_not_writable',
            controlName: 'motor_enabled',
            evidence: {
              attributeStatuses: {
                nodeId: 'Good',
                browse: 'Good',
                dataType: 'Good',
                valueRank: 'Good',
                userAccessLevel: 'Good',
              },
            },
          },
        ],
      },
    });
    expect(write).not.toHaveBeenCalled();
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
        blockingErrors: [
          { code: 'read_root_unavailable', message: 'BadUserAccessDenied' },
          { code: 'control_target_unavailable', message: 'BadUserAccessDenied' },
        ],
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

  it('doctor preserves partial control metadata failures alongside other findings', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: false,
        valueRank: -1,
        attributeStatuses: {
          nodeId: 'Good',
          browse: 'Good',
          dataType: 'BadUserAccessDenied',
          valueRank: 'Good',
          userAccessLevel: 'Good',
        },
      },
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      onlineDiagnostics: {
        blockingErrors: [
          { code: 'control_target_not_writable' },
          {
            code: 'control_target_datatype_unavailable',
            evidence: { attributeStatuses: { dataType: 'BadUserAccessDenied' } },
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

  it('doctor classifies non-scalar Semantic Control targets as online blocking errors', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
        valueRank: 1,
      },
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_blocking_errors',
      onlineDiagnostics: {
        state: 'invalid',
        blockingErrors: [
          {
            code: 'control_target_unsupported_shape',
            controlName: 'motor_enabled',
            expectedValueRank: -1,
            actualValueRank: 1,
          },
        ],
      },
    });
  });

  it('doctor exits 3 for online blocking errors', async () => {
    const configPath = writeTempConfig(configYaml);
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: false,
        dataType: 'Boolean',
      },
    });

    const result = await runCli(['doctor', '--config', configPath], gateway);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_blocking_errors',
      onlineDiagnostics: {
        state: 'invalid',
        blockingErrors: [{ code: 'control_target_not_writable', controlName: 'motor_enabled' }],
      },
    });
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

  it('doctor reports commissioning warnings and can fail strictly on them', async () => {
    const configPath = writeTempConfig(
      configYaml.replace('controls:\n  items:', 'controls:\n  enabled: false\n  items:'),
    );
    const gateway = fakeGateway({
      'ns=2;s=Machine': { exists: true, browseable: true },
      'ns=2;s=Machine.MotorEnabled': {
        exists: true,
        readable: true,
        writable: true,
        dataType: 'Boolean',
      },
    });

    const warningResult = await runCli(['doctor', '--config', configPath], gateway);
    const strictResult = await runCli(
      ['doctor', '--config', configPath, '--strict-warnings'],
      gateway,
    );

    expect(warningResult.exitCode).toBe(0);
    expect(JSON.parse(warningResult.stdout)).toMatchObject({
      ok: true,
      resultClass: 'commissioning_warnings',
      warnings: [{ code: 'controls_disabled' }],
    });
    expect(strictResult.exitCode).toBe(5);
    expect(JSON.parse(strictResult.stdout)).toMatchObject({
      ok: false,
      resultClass: 'strict_warning_failure',
      warnings: [{ code: 'controls_disabled' }],
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

  it('discover-controls writes inactive Semantic Control drafts for Operator review', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.yaml');
    const draftPath = join(dir, 'draft.yaml');
    // Test-owned temporary config path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(configPath, configYaml);
    const gateway = fakeGateway(
      {
        'ns=2;s=Machine.SpeedSetpoint': {
          exists: true,
          readable: true,
          writable: true,
          dataType: 'Double',
        },
      },
      [
        {
          nodeId: 'ns=2;s=Machine.SpeedSetpoint',
          browseName: '2:SpeedSetpoint',
          displayName: 'Speed Setpoint',
          dataType: 'Double',
          readable: true,
          writable: true,
        },
      ],
      {
        'ns=2;s=Machine.SpeedSetpoint': {
          nodeId: 'ns=2;s=Machine.SpeedSetpoint',
          dataType: 'Double',
          value: 42,
        },
      },
    );

    const result = await runCli(
      ['discover-controls', '--config', configPath, '--root', 'ns=2;s=Machine', '--out', draftPath],
      gateway,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Operator review is required');
    // Test-owned temporary draft path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const draftText = readFileSync(draftPath, 'utf8');
    const draft = parseYaml(draftText);
    const draftRecord = asRecord(draft);
    expect(draftRecord['warning']).toEqual(expect.stringContaining('Operator review is required'));
    expect(draftRecord['sourceRoot']).toBe('ns=2;s=Machine');
    expect(draftRecord['semanticControlDrafts']).toMatchObject([
      {
        active: false,
        name: 'speed_setpoint',
        nodeId: 'ns=2;s=Machine.SpeedSetpoint',
        dataType: 'Double',
        writable: true,
        currentValue: 42,
        description: 'TODO: describe this Semantic Control before activation',
        riskLevel: 'TODO_OPERATOR_REVIEW',
        riskNote: 'TODO: document consequence and caution before activation',
      },
    ]);
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

function parseYaml(text: string): unknown {
  return YAML.parse(text) as unknown;
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
  write: ReturnType<typeof vi.fn>;
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
    write: vi.fn(() => Promise.resolve({ opcuaStatus: 'Good' })),
    getNodeMetadata: (nodeId) => Promise.resolve(metadata[nodeId] ?? { exists: false }),
  };
}
