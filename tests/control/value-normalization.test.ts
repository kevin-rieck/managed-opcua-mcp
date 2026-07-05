import { describe, expect, it } from 'vitest';
import { normalizeControlValue } from '../../src/control/value-normalization.js';
import type { ControlItem } from '../../src/config/schema.js';

describe('normalizeControlValue', () => {
  it('normalizes boolean labels and raw booleans', () => {
    const control: ControlItem = {
      name: 'set_pump_enabled',
      description: 'Enables or disables the pump.',
      nodeId: 'ns=2;s=Pump.Enabled',
      dataType: 'Boolean',
      falseLabel: 'disabled',
      trueLabel: 'enabled',
      riskLevel: 'medium',
      riskNote: 'Can start fluid movement.',
    };

    expect(normalizeControlValue(control, 'enabled')).toEqual({ value: 'enabled', rawValue: true });
    expect(normalizeControlValue(control, false)).toEqual({ value: 'disabled', rawValue: false });
  });

  it('rejects numeric values outside configured bounds', () => {
    const control: ControlItem = {
      name: 'set_motor_speed',
      description: 'Sets motor speed.',
      nodeId: 'ns=2;s=Motor.SpeedSetpoint',
      dataType: 'Double',
      unit: 'rpm',
      min: 0,
      max: 1800,
      riskLevel: 'low',
      riskNote: 'Safe test setpoint.',
    };

    expect(() => normalizeControlValue(control, 1801)).toThrow(/outside configured range/);
  });

  it('normalizes enum labels to raw values', () => {
    const control: ControlItem = {
      name: 'set_machine_mode',
      description: 'Sets mode.',
      nodeId: 'ns=2;s=Machine.Mode',
      dataType: 'Int32',
      allowedValues: [
        { label: 'idle', value: 0 },
        { label: 'automatic', value: 1 },
      ],
      riskLevel: 'medium',
      riskNote: 'Changes operating mode.',
    };

    expect(normalizeControlValue(control, 'automatic')).toEqual({ value: 'automatic', rawValue: 1 });
  });
});
