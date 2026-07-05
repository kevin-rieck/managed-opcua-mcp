import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { appConfigSchema, type AppConfig } from './schema.js';

const envRefPattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export interface LoadedConfig {
  config: AppConfig;
  configHash: string;
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  // Config path is an explicit CLI/operator input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = await readFile(path, 'utf8');
  const parsedYaml = YAML.parse(source) as unknown;
  const resolved = resolveNonSecretEnvironment(parsedYaml);
  const config = appConfigSchema.parse(resolved);
  return { config, configHash: await computeConfigHash(config) };
}

export function resolveNonSecretEnvironment(value: unknown): unknown {
  return resolveEnvRefs(value, []);
}

function resolveEnvRefs(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    if (isSecretPath(path)) return value;
    return value.replace(envRefPattern, (_match, name: string) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(`Missing required environment variable ${name}.`);
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveEnvRefs(item, [...path, String(index)]));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolveEnvRefs(nested, [...path, key])]),
    );
  }
  return value;
}

function isSecretPath(path: string[]): boolean {
  return path.join('.') === 'connection.auth.username' || path.join('.') === 'connection.auth.password';
}

export async function computeConfigHash(config: AppConfig): Promise<string> {
  const json = stableStringify(redactSecretValues(config));
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function redactSecretValues(config: AppConfig): unknown {
  const copy = structuredClone(config);
  if (copy.connection.auth.type === 'usernamePassword') {
    copy.connection.auth.username = '[redacted]';
    copy.connection.auth.password = '[redacted]';
  }
  return copy;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}
