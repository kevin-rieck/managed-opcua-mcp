import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../../src/config/schema.js';

const baseConfig = {
  version: 2,
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  read: {
    roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
  },
  audit: { file: './audit.jsonl' },
} as const;

describe('appConfigSchema', () => {
  it('accepts the canonical simplified config shape', () => {
    const parsed = appConfigSchema.parse(baseConfig);

    expect(parsed.read.defaultBrowseDepth).toBe(1);
    expect(parsed.read.maxBrowseDepth).toBe(10);
    expect(parsed.read.maxReadBatchSize).toBe(50);
  });

  it('rejects removed controls and unsupported versions', () => {
    expect(appConfigSchema.safeParse({ ...baseConfig, controls: { items: [] } }).success).toBe(
      false,
    );
    expect(appConfigSchema.safeParse({ ...baseConfig, version: 1 }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...baseConfig, version: 3 }).success).toBe(false);
  });

  it('rejects unknown config fields', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      accidentalPolicyTypo: true,
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Read Entry Point labels', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      read: {
        roots: [
          { nodeId: 'ns=2;s=Machine', label: 'machine' },
          { nodeId: 'ns=2;s=OtherMachine', label: 'machine' },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects the old server mode and readScope config shape', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      server: { mode: 'readWrite' },
      readScope: { roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }] },
    });

    expect(result.success).toBe(false);
  });

  it('rejects literal username/password secrets', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      connection: {
        ...baseConfig.connection,
        auth: { type: 'usernamePassword', username: 'operator', password: 'secret' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts username/password environment references', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      connection: {
        ...baseConfig.connection,
        auth: {
          type: 'usernamePassword',
          username: '${OPCUA_USERNAME}',
          password: '${OPCUA_PASSWORD}',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid read limits', () => {
    const config = {
      ...baseConfig,
      read: {
        defaultBrowseDepth: 5,
        maxBrowseDepth: 3,
        maxReadBatchSize: 0,
        roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
      },
    };

    expect(appConfigSchema.safeParse(config).success).toBe(false);
  });
});
