export type NativeDataType =
  | 'Boolean'
  | 'SByte'
  | 'Byte'
  | 'Int16'
  | 'UInt16'
  | 'Int32'
  | 'UInt32'
  | 'Float'
  | 'Double'
  | 'String';
export type NativeScalar = boolean | number | string;
export interface NativeNodeId {
  text: string;
  namespace: number;
  type: 'NUMERIC' | 'STRING' | 'GUID' | 'BYTESTRING';
  value: number | string | Buffer;
}
export type EncodingErrorCode =
  | 'invalid_node_id'
  | 'node_id_too_long'
  | 'unsupported_data_type'
  | 'invalid_value'
  | 'value_out_of_range'
  | 'value_too_long';
export class NativeEncodingError extends Error {
  constructor(public readonly code: EncodingErrorCode) {
    super(code);
  }
}

export function validUnicode(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

export function parseNativeNodeId(input: string): NativeNodeId {
  if (!validUnicode(input)) throw new NativeEncodingError('invalid_node_id');
  if (input.length > 8192 || Array.from(input).length > 4096)
    throw new NativeEncodingError('node_id_too_long');
  // The input is bounded above before applying this expression.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(?:ns=([0-9]+);)?([isgb])=([\s\S]*)$/u.exec(input);
  if (!match) throw new NativeEncodingError('invalid_node_id');
  const namespace = Number(match[1] ?? '0');
  const kind = match[2] ?? '';
  const id = match[3] ?? '';
  if (!Number.isSafeInteger(namespace) || namespace > 65535)
    throw new NativeEncodingError('invalid_node_id');
  let type: NativeNodeId['type'];
  let value: NativeNodeId['value'];
  let canonical: string;
  if (kind === 'i') {
    const number = Number(id);
    if (!/^[0-9]+(?![\s\S])/u.test(id) || !Number.isSafeInteger(number) || number > 0xffffffff)
      throw new NativeEncodingError('invalid_node_id');
    type = 'NUMERIC';
    value = number;
    canonical = String(number);
  } else if (kind === 's') {
    type = 'STRING';
    value = id;
    canonical = id;
  } else if (kind === 'g') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/iu.test(id))
      throw new NativeEncodingError('invalid_node_id');
    type = 'GUID';
    value = id.toLowerCase();
    canonical = value;
  } else {
    if (!/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/u.test(id))
      throw new NativeEncodingError('invalid_node_id');
    const bytes = Buffer.from(id, 'base64');
    if (bytes.toString('base64') !== id) throw new NativeEncodingError('invalid_node_id');
    type = 'BYTESTRING';
    value = bytes;
    canonical = id;
  }
  return {
    text: `${namespace === 0 ? '' : `ns=${String(namespace)};`}${kind}=${canonical}`,
    namespace,
    type,
    value,
  };
}

const integerRanges: Record<string, readonly [number, number]> = {
  SByte: [-128, 127],
  Byte: [0, 255],
  Int16: [-32768, 32767],
  UInt16: [0, 65535],
  Int32: [-2147483648, 2147483647],
  UInt32: [0, 4294967295],
};
export function validateNativeScalar(
  dataType: string,
  value: unknown,
): { dataType: NativeDataType; value: NativeScalar } {
  if (dataType === 'Boolean') {
    if (typeof value !== 'boolean') throw new NativeEncodingError('invalid_value');
  } else if (dataType === 'String') {
    if (typeof value !== 'string' || !validUnicode(value))
      throw new NativeEncodingError('invalid_value');
    if (value.length > 8192 || Array.from(value).length > 4096)
      throw new NativeEncodingError('value_too_long');
  } else if (
    Object.hasOwn(integerRanges, dataType) ||
    dataType === 'Float' ||
    dataType === 'Double'
  ) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new NativeEncodingError('invalid_value');
    const range = integerRanges[dataType];
    if (
      (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) ||
      (dataType === 'Float' && !Number.isFinite(Math.fround(value)))
    )
      throw new NativeEncodingError('value_out_of_range');
  } else {
    throw new NativeEncodingError('unsupported_data_type');
  }
  return { dataType: dataType as NativeDataType, value };
}
