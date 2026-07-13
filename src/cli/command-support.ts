import YAML from 'yaml';
import { z } from 'zod';
import { loadConfigFile, type LoadedConfig } from '../config/load-config.js';
import type { AppConfig } from '../config/schema.js';
import { getOnlineValidation } from '../mcp/online-validation.js';
import type { OpcUaGateway } from '../opcua/gateway.js';

export type GatewayFactory = (config: AppConfig) => OpcUaGateway;

export interface CommandOutput {
  stdout: (text: string) => void;
  setExitCode: (code: number) => void;
}

export async function loadConfigForCli(
  configPath: string,
): Promise<
  | { ok: true; loaded: LoadedConfig }
  | { ok: false; failure: ReturnType<typeof formatValidationFailure> }
> {
  try {
    return { ok: true, loaded: await loadConfigFile(configPath) };
  } catch (error) {
    return { ok: false, failure: formatValidationFailure(error) };
  }
}

export async function runOnlineValidation(
  loaded: LoadedConfig,
  gatewayFactory: GatewayFactory,
  timeoutMs: number,
): Promise<unknown> {
  const gateway = gatewayFactory(loaded.config);
  await gateway.connect();
  try {
    await waitForOnlineValidationAttempt(gateway, timeoutMs);
    return await getOnlineValidation(loaded.config, gateway, {});
  } finally {
    await gateway.close();
  }
}

export async function waitForOnlineValidationAttempt(
  gateway: OpcUaGateway,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await gateway.status();
    if (status.state === 'connected') return;
    await sleep(50);
  }
}

export function parseOnlineTimeout(value: string | undefined): number {
  const timeoutMs = Number(value ?? '5000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new Error(
      'validate-config online timeout must be an integer between 0 and 60000 milliseconds.',
    );
  }
  return timeoutMs;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, '[redacted-secret-ref]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSecretKey(key) ? '[redacted]' : redactSecrets(nested),
      ]),
    );
  }
  return value;
}

export function formatValidationFailure(error: unknown): {
  ok: false;
  validationErrors: { path: string; code: string; message: string }[];
} {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      validationErrors: error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  return {
    ok: false,
    validationErrors: [
      {
        path: '(root)',
        code: errorCode(error),
        message: error instanceof Error ? error.message : 'Unknown validation error.',
      },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSecretKey(key: string): boolean {
  return ['password', 'username', 'token', 'secret'].some((secretKey) =>
    key.toLowerCase().includes(secretKey),
  );
}

function errorCode(error: unknown): string {
  if (error instanceof YAML.YAMLParseError) return 'YAML_PARSE_ERROR';
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'validation_error';
}
