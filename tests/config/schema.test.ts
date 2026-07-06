import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../../src/config/schema.js';

const baseConfig = {
  version: 1,
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
  controls: {
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
  it('accepts the canonical simplified config shape', () => {
    const parsed = appConfigSchema.parse(baseConfig);

    expect(parsed.controls?.enabled).toBe(true);
    expect(parsed.read.defaultBrowseDepth).toBe(1);
    expect(parsed.read.maxBrowseDepth).toBe(10);
    expect(parsed.read.maxReadBatchSize).toBe(50);
  });

  it('accepts config without controls and exposes no Control Surface', () => {
    const withoutControls: Record<string, unknown> = structuredClone(baseConfig);
    delete withoutControls['controls'];

    const parsed = appConfigSchema.parse(withoutControls);

    expect(parsed.controls).toBeUndefined();
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

  it('rejects duplicate Read Entry Point and Semantic Control agent-facing names', () => {
    const result = appConfigSchema.safeParse({
      ...baseConfig,
      controls: {
        items: [
          {
            name: 'machine',
            description: 'Sets the motor speed setpoint.',
            nodeId: 'ns=2;s=Motor.SpeedSetpoint',
            dataType: 'Double',
            unit: 'rpm',
            min: 0,
            max: 1800,
            riskLevel: 'medium',
            riskNote: 'Changes motor speed.',
          },
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

  it('rejects high-risk controls because v1 does not support them', () => {
    const config = structuredClone(baseConfig);
    Object.assign(config.controls.items[0], { riskLevel: 'high' });

    expect(appConfigSchema.safeParse(config).success).toBe(false);
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

  it('accepts controls.enabled as an optional commissioning switch', () => {
    const parsed = appConfigSchema.parse({
      ...baseConfig,
      controls: { ...baseConfig.controls, enabled: false },
    });

    expect(parsed.controls?.enabled).toBe(false);
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

  it('validates numeric, string, enum-like, and boolean Semantic Control shapes', () => {
    const config = {
      ...baseConfig,
      controls: {
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
