/* eslint-disable security/detect-non-literal-fs-filename -- test-owned temporary paths */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../../src/cli/index.js';
import type {
  CommissioningDiscoveryGateway,
  CommissioningDiscoveryResult,
  Evidence,
} from '../../src/commissioning/discovery.js';
import type { OpcUaGateway, OpcUaStatus } from '../../src/opcua/gateway.js';

const configYaml = `
version: 1
connection:
  endpointUrl: opc.tcp://plant.example:4840
  securityMode: None
  securityPolicy: None
  auth:
    type: usernamePassword
    username: \${PLANT_USERNAME}
    password: \${PLANT_PASSWORD}
read:
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
audit:
  file: ./audit.jsonl
`;

describe('setup CLI', () => {
  it('stops before discovery and writes no outputs when local validation fails', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'invalid.yaml');
    const draftPath = join(dir, 'draft.yaml');
    const reportPath = join(dir, 'report.md');
    writeFileSync(configPath, `${configYaml}unknown: true\n`);
    const gateway = setupGateway(discovery());

    const result = await runSetup(
      ['setup', '--config', configPath, '--out', draftPath, '--report', reportPath],
      gateway,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'local_validation_failed',
      localValidation: { ok: false, errors: [{ code: 'unrecognized_keys' }] },
    });
    expect(gateway.connect.mock.calls).toHaveLength(0);
    expect(() => readFileSync(draftPath, 'utf8')).toThrow();
    expect(() => readFileSync(reportPath, 'utf8')).toThrow();
  });

  it('writes review outputs but reports a blocking result when online diagnostics fail', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'input.yaml');
    const draftPath = join(dir, 'draft.yaml');
    const reportPath = join(dir, 'report.md');
    writeFileSync(configPath, configYaml);
    const gateway = setupGateway(discovery());
    gateway.getNodeMetadata = vi.fn(() =>
      Promise.reject(new Error('Authentication failed for alice with literal-secret')),
    );

    const result = await runSetup(
      ['setup', '--config', configPath, '--out', draftPath, '--report', reportPath],
      gateway,
    );

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      resultClass: 'online_blocking_errors',
      recommendation: 'not_ready_to_serve',
      onlineDiagnostics: {
        state: 'invalid',
        blockingErrors: [{ code: 'read_root_unavailable' }],
      },
    });
    expect(readFileSync(draftPath, 'utf8')).toContain('Draft OPC UA MCP config');
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('read_root_unavailable');
    expect(report).not.toContain('alice');
    expect(report).not.toContain('literal-secret');
    expect(result.stdout).not.toContain('alice');
    expect(result.stdout).not.toContain('literal-secret');
  });

  it('preserves partial discovery warnings and still writes review outputs', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'input.yaml');
    const draftPath = join(dir, 'draft.yaml');
    const reportPath = join(dir, 'report.md');
    writeFileSync(configPath, configYaml);
    const partial = discovery();
    const firstRoot = partial.roots[0];
    if (firstRoot === undefined) throw new Error('fixture requires a discovery root');
    firstRoot.status = 'partial';
    partial.findings.warnings.push({
      code: 'partial_discovery',
      area: firstRoot.nodeId,
      message: 'Some metadata was unavailable.',
    });
    const gateway = setupGateway(partial);

    const result = await runSetup(
      ['setup', '--config', configPath, '--out', draftPath, '--report', reportPath],
      gateway,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      resultClass: 'commissioning_warnings',
      discovery: { warnings: 1 },
    });
    expect(readFileSync(reportPath, 'utf8')).toContain('partial_discovery');
  });

  it('adds discovered Read Entry Point suggestions to a config that has no configured roots', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'input.yaml');
    const draftPath = join(dir, 'draft.yaml');
    const reportPath = join(dir, 'report.md');
    writeFileSync(
      configPath,
      configYaml.replace(
        'read:\n  roots:\n    - nodeId: ns=2;s=Machine\n      label: machine',
        'read:\n  roots: []',
      ),
    );
    const gateway = setupGateway(discovery());

    const result = await runSetup(
      ['setup', '--config', configPath, '--out', draftPath, '--report', reportPath],
      gateway,
    );

    expect(result.exitCode).toBe(0);
    expect(parseYaml(readFileSync(draftPath, 'utf8'))).toMatchObject({
      read: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
    });
    expect(gateway.discoverCommissioning).toHaveBeenCalledWith(
      expect.objectContaining({ roots: [] }),
    );
  });

  it('writes an explicit valid draft config and commissioning report without activating candidates', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'input.yaml');
    const draftPath = join(dir, 'draft.yaml');
    const reportPath = join(dir, 'report.md');
    writeFileSync(configPath, configYaml);
    const gateway = setupGateway(discovery());

    const result = await runSetup(
      ['setup', '--config', configPath, '--out', draftPath, '--report', reportPath],
      gateway,
    );

    expect(result.exitCode).toBe(0);
    const output = asRecord(JSON.parse(result.stdout) as unknown);
    expect(output).toMatchObject({
      ok: true,
      resultClass: 'commissioning_warnings',
      commissioningState: 'online_validated',
      generated: { configPath: draftPath, reportPath },
      recommendation: 'operator_review_required',
    });
    expect(output['nextActions']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Review'),
        expect.stringContaining('doctor'),
      ]),
    );
    const draftText = readFileSync(draftPath, 'utf8');
    const draft = asRecord(parseYaml(draftText));
    expect(draft).toMatchObject({
      connection: {
        auth: { username: '${PLANT_USERNAME}', password: '${PLANT_PASSWORD}' },
      },
    });
    expect(draftText).toContain('Draft Semantic Control candidate: set_machine_speed');
    expect(draftText).toContain('# nodeId: ns=2;s=Machine.Speed');
    expect((draft['controls'] as { items?: unknown[] } | undefined)?.items ?? []).toEqual([]);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('# OPC UA MCP Commissioning Report');
    expect(report).toContain('Candidate: `set_machine_speed`');
    expect(report).not.toContain('PLANT_PASSWORD');
    expect(gateway.write).not.toHaveBeenCalled();
    expect(gateway.read).not.toHaveBeenCalled();
    expect(gateway.discoverCommissioning).toHaveBeenCalledWith({
      roots: ['ns=2;s=Machine'],
      maxDepth: 4,
      maxNodes: 1000,
    });
  });
});

async function runSetup(
  args: string[],
  gateway: OpcUaGateway & CommissioningDiscoveryGateway,
): Promise<{ exitCode: number; stdout: string }> {
  let exitCode = 0;
  let stdout = '';
  const program = createCliProgram({
    gatewayFactory: () => gateway,
    stdout: (text) => {
      stdout += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(['node', 'opcua-mcp', ...args]);
  return { exitCode, stdout };
}

function setupGateway(
  result: CommissioningDiscoveryResult,
  status: OpcUaStatus = { state: 'connected', connectionGeneration: 1 },
): OpcUaGateway &
  CommissioningDiscoveryGateway & {
    connect: ReturnType<typeof vi.fn>;
    discoverCommissioning: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  } {
  return {
    status: () => Promise.resolve(status),
    connect: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    browse: vi.fn(() => Promise.resolve([])),
    read: vi.fn(() => Promise.reject(new Error('setup must not read current values'))),
    readMany: vi.fn(() => Promise.resolve([])),
    write: vi.fn(() => Promise.reject(new Error('setup must not write values'))),
    getNodeMetadata: vi.fn(() => Promise.resolve({ exists: true, browseable: true })),
    discoverCommissioning: vi.fn(() => Promise.resolve(structuredClone(result))),
  };
}

function discovery(): CommissioningDiscoveryResult {
  return {
    generatedAt: '2026-07-13T20:00:00.000Z',
    roots: [{ nodeId: 'ns=2;s=Machine', status: 'succeeded', nodesVisited: 2, depthReached: 1 }],
    nodes: [],
    suggestedReadEntryPoints: [
      {
        nodeId: 'ns=2;s=Machine',
        suggestedLabel: 'machine',
        reason: 'requested_root',
        evidence: [evidence('browsed')],
      },
    ],
    draftSemanticControls: [
      {
        nodeId: 'ns=2;s=Machine.Speed',
        suggestedName: 'set_machine_speed',
        description: 'Machine speed',
        dataType: 'Double',
        unit: 'rpm',
        normalRange: { low: 0, high: 100 },
        draftState: 'inactive_review_required',
        eligibility: 'needs_operator_review',
        reasons: ['scalar_supported_data_type', 'operator_safety_fields_required'],
        evidence: [evidence('Double')],
      },
    ],
    writableButNotSuggested: [],
    findings: { blocking: [], warnings: [] },
    coverage: {
      requestedRoots: 1,
      succeededRoots: 1,
      failedRoots: 0,
      nodesVisited: 2,
      maxNodes: 1000,
      depthRequested: 4,
      depthReached: 1,
      fields: {},
    },
  };
}

function evidence<T>(value: T): Evidence<T> {
  return {
    value,
    source: 'metadata_read',
    status: { severity: 'good', code: 'Good' },
  };
}

function parseYaml(text: string): unknown {
  return YAML.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object.');
  }
  return value as Record<string, unknown>;
}

function tempDir(): string {
  const dir = join(tmpdir(), `opcua-mcp-setup-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
