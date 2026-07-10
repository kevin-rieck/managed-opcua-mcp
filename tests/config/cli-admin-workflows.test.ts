import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../../src/cli/index.js';
import type { BrowseNodeResult, NodeMetadataResult, OpcUaGateway, OpcUaStatus, ReadValueResult } from '../../src/opcua/gateway.js';

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
      { 'ns=2;s=Machine.SpeedSetpoint': { nodeId: 'ns=2;s=Machine.SpeedSetpoint', dataType: 'Double', value: 42 } },
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

async function runCli(args: string[], gateway: OpcUaGateway): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
): OpcUaGateway & { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    status: (): Promise<OpcUaStatus> => Promise.resolve({ state: 'connected', connectionGeneration: 1 }),
    connect: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    browse: () => Promise.resolve(browseResults),
    read: (nodeId) => {
      const result = readResults[nodeId];
      if (result === undefined) return Promise.reject(new Error('not readable'));
      return Promise.resolve(result);
    },
    readMany: (nodeIds) =>
      Promise.all(nodeIds.map((nodeId) => Promise.resolve(readResults[nodeId] ?? { nodeId, value: null }))),
    write: () => Promise.resolve({ opcuaStatus: 'Good' }),
    getNodeMetadata: (nodeId) => Promise.resolve(metadata[nodeId] ?? { exists: false }),
  };
}
