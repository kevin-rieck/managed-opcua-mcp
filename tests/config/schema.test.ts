import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../../src/config/schema.js';

const baseReadWriteConfig = {
  version: 1,
  server: { mode: 'readWrite' },
  connection: {
    endpointUrl: 'opc.tcp://localhost:4840',
    securityMode: 'None',
    securityPolicy: 'None',
    auth: { type: 'anonymous' },
  },
  readScope: {
    roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
  },
  audit: { file: './audit.jsonl' },
  controls: {
    enabled: false,
    items: [
      {
        name: 'set_motor_speed',
        description: 'Sets the motor speed setpoint.',
        nodeId: 'ns=2;s=Motor.SpeedSetpoint',
        dataType: 'Double',
        unit: 'rpm',
        min: 0,
        max: 1800,
        riskLevel: 'medium',
        riskNote: 'Changes motor speed.',
        requireCurrentValueForConfirmation: true,
      },
    ],
  },
} as const;

describe('appConfigSchema', () => {
  it('accepts the canonical readWrite shape', () => {
    expect(appConfigSchema.parse(baseReadWriteConfig).server.mode).toBe('readWrite');
  });

  it('rejects unknown config fields', () => {
    const result = appConfigSchema.safeParse({
      ...baseReadWriteConfig,
      accidentalPolicyTypo: true,
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate Read Scope labels', () => {
    const result = appConfigSchema.safeParse({
      ...baseReadWriteConfig,
      readScope: {
        roots: [
          { nodeId: 'ns=2;s=Machine', label: 'machine' },
          { nodeId: 'ns=2;s=OtherMachine', label: 'machine' },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects controls in readOnly mode', () => {
    const result = appConfigSchema.safeParse({
      ...baseReadWriteConfig,
      server: { mode: 'readOnly' },
    });

    expect(result.success).toBe(false);
  });

  it('requires controls in readWrite mode', () => {
    const withoutControls: Record<string, unknown> = { ...baseReadWriteConfig };
    delete withoutControls['controls'];
    const result = appConfigSchema.safeParse(withoutControls);

    expect(result.success).toBe(false);
  });

  it('rejects high-risk controls because v1 does not support them', () => {
    const config = structuredClone(baseReadWriteConfig);
    Object.assign(config.controls.items[0], { riskLevel: 'high' });

    expect(appConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects literal username/password secrets', () => {
    const result = appConfigSchema.safeParse({
      ...baseReadWriteConfig,
      connection: {
        ...baseReadWriteConfig.connection,
        auth: { type: 'usernamePassword', username: 'operator', password: 'secret' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires readWrite controls to explicitly set controls.enabled', () => {
    const config: Record<string, unknown> = structuredClone(baseReadWriteConfig);
    const controls = config['controls'] as Record<string, unknown>;
    delete controls['enabled'];

    expect(appConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts username/password environment references', () => {
    const result = appConfigSchema.safeParse({
      ...baseReadWriteConfig,
      connection: {
        ...baseReadWriteConfig.connection,
        auth: {
          type: 'usernamePassword',
          username: '${OPCUA_USERNAME}',
          password: '${OPCUA_PASSWORD}',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('validates numeric, string, enum-like, and boolean Semantic Control shapes', () => {
    const config = {
      ...baseReadWriteConfig,
      controls: {
        ...baseReadWriteConfig.controls,
        items: [
          {
            name: 'set_motor_speed',
            description: 'Sets the motor speed setpoint.',
            nodeId: 'ns=2;s=Motor.SpeedSetpoint',
            dataType: 'Double',
            unit: 'rpm',
            min: 0,
            max: 1800,
            riskLevel: 'low',
            riskNote: 'Safe simulator setpoint.',
          },
          {
            name: 'set_machine_mode',
            description: 'Sets the machine operating mode.',
            nodeId: 'ns=2;s=Machine.Mode',
            dataType: 'Int32',
            allowedValues: [
              { label: 'idle', value: 0 },
              { label: 'automatic', value: 1 },
            ],
            riskLevel: 'medium',
            riskNote: 'Changes operating mode.',
          },
          {
            name: 'set_recipe_name',
            description: 'Sets the active recipe name.',
            nodeId: 'ns=2;s=Recipe.Name',
            dataType: 'String',
            allowedValues: [
              { label: 'water_test', value: 'water-test' },
              { label: 'dry_run', value: 'dry-run' },
            ],
            riskLevel: 'low',
            riskNote: 'Uses approved test recipes only.',
          },
          {
            name: 'set_pump_enabled',
            description: 'Enables or disables the pump.',
            nodeId: 'ns=2;s=Pump.Enabled',
            dataType: 'Boolean',
            falseLabel: 'disabled',
            trueLabel: 'enabled',
            riskLevel: 'medium',
            riskNote: 'Can start fluid movement.',
          },
        ],
      },
    };

    expect(appConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects invalid Read Scope limits and exclusion conflicts', () => {
    const config = {
      ...baseReadWriteConfig,
      readScope: {
        defaultDepth: 5,
        maxDepth: 3,
        maxReadBatchSize: 0,
        roots: [{ nodeId: 'ns=2;s=Machine', label: 'machine' }],
        nodes: [{ nodeId: 'ns=2;s=Machine.Secret', label: 'machine_secret' }],
        exclude: [{ nodeId: 'ns=2;s=Machine.Secret', kind: 'exact' }],
      },
    };

    expect(appConfigSchema.safeParse(config).success).toBe(false);
  });
});
