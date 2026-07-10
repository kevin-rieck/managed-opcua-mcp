import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

interface SuccessfulValidationOutput {
  ok: true;
  configHash: string;
}

interface FailedValidationOutput {
  ok: false;
  validationErrors: { path: string; code: string; message: string }[];
}

function runValidateConfig(configYaml: string, command = 'validate') {
  const dir = join(tmpdir(), `opcua-mcp-config-${randomUUID()}`);
  // Test-owned temporary directory path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.yaml');
  // Test-owned temporary config path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(configPath, configYaml);

  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', command, '--config', configPath], {
    encoding: 'utf8',
  });
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    encoding: 'utf8',
  });
}

const readConfig = `
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
`;

const controlConfig = `
version: 1
connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: None
  securityPolicy: None
  auth:
    type: usernamePassword
    username: \${OPCUA_USERNAME}
    password: \${OPCUA_PASSWORD}
read:
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
audit:
  file: ./audit.jsonl
controls:
  items:
    - name: set_motor_speed
      description: Sets the motor speed setpoint.
      nodeId: ns=2;s=Motor.SpeedSetpoint
      dataType: Double
      unit: rpm
      min: 0
      max: 1800
      riskLevel: low
      riskNote: Safe simulator setpoint.
`;

describe('validate CLI', () => {
  it('prints a deterministic non-secret config hash for valid read config', () => {
    const first = runValidateConfig(readConfig);
    const second = runValidateConfig(readConfig);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstBody = parseSuccessfulValidationOutput(first.stdout);
    const secondBody = parseSuccessfulValidationOutput(second.stdout);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.configHash).toMatch(/^[a-f0-9]{16}$/);
    expect(secondBody.configHash).toBe(firstBody.configHash);
  });

  it('accepts representative control config with secret environment references and optional controls.enabled', () => {
    const result = runValidateConfig(controlConfig);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configHash');
    expect(result.stdout).not.toContain('resolved-secret');
  });

  it('rejects unknown fields with clear validation errors and no stack trace', () => {
    const result = runValidateConfig(`${readConfig}unexpectedField: true\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('ZodError');
    expect(result.stderr).not.toContain('src/');
    const body = parseFailedValidationOutput(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.validationErrors).toHaveLength(1);
    expect(body.validationErrors[0]?.path).toBe('(root)');
    expect(body.validationErrors[0]?.code).toBe('unrecognized_keys');
    expect(body.validationErrors[0]?.message).toContain(
      "Unrecognized key(s) in object: 'unexpectedField'",
    );
  });

  it('keeps validate-config as a compatibility alias with a deprecation warning', () => {
    const result = runValidateConfig(readConfig, 'validate-config');

    expect(result.status).toBe(0);
    expect(parseSuccessfulValidationOutput(result.stdout).ok).toBe(true);
    expect(result.stderr).toContain('validate-config is deprecated; use validate instead.');
  });

  it('returns exit code 1 and JSON details for unreadable config files', () => {
    const result = runCli(['validate', '--config', '/path/that/does/not/exist.yaml']);

    expect(result.status).toBe(1);
    const body = parseFailedValidationOutput(result.stdout);
    expect(body.validationErrors[0]).toMatchObject({ path: '(root)', code: 'ENOENT' });
  });

  it('returns exit code 1 and JSON details for unparseable config files', () => {
    const result = runValidateConfig('version: [unterminated\n');

    expect(result.status).toBe(1);
    const body = parseFailedValidationOutput(result.stdout);
    expect(body.validationErrors[0]).toMatchObject({ path: '(root)', code: 'YAML_PARSE_ERROR' });
  });

  it('returns exit code 2 for CLI usage errors', () => {
    const result = runCli(['validate']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("required option '-c, --config <path>' not specified");
  });
});

function parseSuccessfulValidationOutput(text: string): SuccessfulValidationOutput {
  const parsed = parseJson(text);
  if (!isSuccessfulValidationOutput(parsed)) {
    throw new Error('Expected successful validation output.');
  }
  return parsed;
}

function parseFailedValidationOutput(text: string): FailedValidationOutput {
  const parsed = parseJson(text);
  if (!isFailedValidationOutput(parsed)) {
    throw new Error('Expected failed validation output.');
  }
  return parsed;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isSuccessfulValidationOutput(value: unknown): value is SuccessfulValidationOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === true &&
    'configHash' in value &&
    typeof value.configHash === 'string'
  );
}

function isFailedValidationOutput(value: unknown): value is FailedValidationOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === false &&
    'validationErrors' in value &&
    Array.isArray(value.validationErrors) &&
    (value.validationErrors as unknown[]).every(isValidationError)
  );
}

function isValidationError(value: unknown): value is { path: string; code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}
