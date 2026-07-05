import type { ControlItem } from '../config/schema.js';

export interface NormalizedControlValue {
  value: unknown;
  rawValue: unknown;
}

export function normalizeControlValue(control: ControlItem, input: unknown): NormalizedControlValue {
  if (control.dataType === 'Boolean') {
    if (typeof input === 'boolean') {
      return { value: input ? control.trueLabel : control.falseLabel, rawValue: input };
    }
    if (input === control.trueLabel) return { value: control.trueLabel, rawValue: true };
    if (input === control.falseLabel) return { value: control.falseLabel, rawValue: false };
    throw new Error(`Expected boolean or one of ${control.falseLabel}, ${control.trueLabel}.`);
  }

  if ('allowedValues' in control) {
    const allowed = control.allowedValues.find((candidate) => candidate.label === input || candidate.value === input);
    if (allowed === undefined) throw new Error('Value is not one of the configured allowedValues.');
    return { value: allowed.label, rawValue: allowed.value };
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('Expected a finite number.');
  }
  if (input < control.min || input > control.max) {
    throw new Error(`${String(input)} is outside configured range ${String(control.min)}..${String(control.max)} ${control.unit}.`);
  }
  return { value: input, rawValue: input };
}
