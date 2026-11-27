import { describe, expect, it } from 'vitest';
import {
  NativeEncodingError,
  parseNativeNodeId,
  validateNativeScalar,
  validUnicode,
} from '../../src/opcua/native-encoding.js';
import { mapStatusCode, statusSeverity } from '../../src/opcua/status-code.js';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof NativeEncodingError) return error.code;
    throw error;
  }
}

describe('native scalar encoding', () => {
  it.each([
    ['SByte', -128, 127],
    ['Byte', 0, 255],
    ['Int16', -32768, 32767],
    ['UInt16', 0, 65535],
    ['Int32', -2147483648, 2147483647],
    ['UInt32', 0, 4294967295],
  ])('%s validates exact integer limits', (type, min, max) => {
    for (const value of [min, max]) expect(validateNativeScalar(type, value).value).toBe(value);
    for (const value of [min - 1, max + 1, 0.5])
      expect(errorCode(() => validateNativeScalar(type, value))).toBe('value_out_of_range');
  });
  it('validates Boolean, Float, Double and String without coercion', () => {
    for (const value of [false, true])
      expect(validateNativeScalar('Boolean', value).value).toBe(value);
    for (const value of [-3.4028234e38, 3.4028234e38, 1e-50])
      expect(validateNativeScalar('Float', value).value).toBe(value);
    for (const value of [-Number.MAX_VALUE, Number.MAX_VALUE])
      expect(validateNativeScalar('Double', value).value).toBe(value);
    expect(validateNativeScalar('String', '').value).toBe('');
    expect(validateNativeScalar('String', '😀'.repeat(4096)).value).toHaveLength(8192);
    for (const value of [-3.5e38, 3.5e38])
      expect(errorCode(() => validateNativeScalar('Float', value))).toBe('value_out_of_range');
    expect(errorCode(() => validateNativeScalar('String', '😀'.repeat(4097)))).toBe(
      'value_too_long',
    );
    for (const [type, value] of [
      ['Boolean', 'true'],
      ['String', '\ud800'],
      ['Double', Infinity],
      ['Int32', null],
      ['Int32', []],
      ['String', {}],
    ] as const) {
      expect(errorCode(() => validateNativeScalar(type, value))).toBe('invalid_value');
    }
    expect(errorCode(() => validateNativeScalar('Int64', 1))).toBe('unsupported_data_type');
    expect(validUnicode('a😀\n')).toBe(true);
    expect(validUnicode('\udc00')).toBe(false);
  });
});

describe('local NodeIds', () => {
  it.each([
    ['ns=0000;i=00042', 'i=42'],
    ['ns=65535;i=4294967295', 'ns=65535;i=4294967295'],
    ['ns=2;s=a;\nb😀', 'ns=2;s=a;\nb😀'],
    ['s=', 's='],
    ['g=ABCDEF00-1234-ABCD-9876-ABCDEFABCDEF', 'g=abcdef00-1234-abcd-9876-abcdefabcdef'],
    ['b=AA==', 'b=AA=='],
    ['b=', 'b='],
  ])('canonicalizes %s', (input, output) => expect(parseNativeNodeId(input).text).toBe(output));
  it.each([
    '',
    'ns=65536;i=0',
    'i=4294967296',
    'i=-1',
    'i=1x',
    ' i=1',
    'i=1\n',
    'nsu=urn:x;i=1',
    'svr=1;i=1',
    'g=abc',
    'b=AB==',
    'b=AA',
    's=\ud800',
  ])('rejects malformed %s', (input) => {
    expect(errorCode(() => parseNativeNodeId(input))).toBe('invalid_node_id');
  });
  it('bounds Unicode scalar length', () => {
    expect(parseNativeNodeId('s=' + '😀'.repeat(4094)).text).toHaveLength(8190);
    expect(errorCode(() => parseNativeNodeId('s=' + '😀'.repeat(4095)))).toBe('node_id_too_long');
  });
});

describe('StatusCode mapping', () => {
  it('preserves bits and classifies numerically despite misleading names', () => {
    for (const [value, name, severity] of [
      [0x00000001, 'Bad', 'good'],
      [0x40000000, 'Good', 'uncertain'],
      [0x801f0000, 'Good', 'bad'],
      [0xc0000001, 'Good', 'reserved'],
    ] as const) {
      const status = mapStatusCode({ value, name });
      expect(status).toEqual({ value, name, hex: `0x${value.toString(16).padStart(8, '0')}` });
      if (!status) throw new Error('Expected a valid status');
      expect(statusSeverity(status)).toBe(severity);
    }
    expect(mapStatusCode(1)).toEqual({ value: 1, hex: '0x00000001', name: 'Unknown' });
    for (const value of [undefined, { name: 'Good' }, -1, 2 ** 32, NaN, 1.5])
      expect(mapStatusCode(value)).toBeUndefined();
  });
});
