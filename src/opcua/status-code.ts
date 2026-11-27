export interface StatusCode {
  value: number;
  hex: string;
  name: string;
}

export function mapStatusCode(input: unknown): StatusCode | undefined {
  const object = typeof input === 'object' && input !== null ? input : undefined;
  const value = object && 'value' in object ? object.value : input;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    return undefined;
  const name =
    object && 'name' in object && typeof object.name === 'string' ? object.name : 'Unknown';
  return { value, hex: `0x${value.toString(16).padStart(8, '0')}`, name };
}

export function statusSeverity(status: StatusCode): 'good' | 'uncertain' | 'bad' | 'reserved' {
  return (['good', 'uncertain', 'bad', 'reserved'] as const)[status.value >>> 30] ?? 'reserved';
}

export class OpcUaStatusError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: StatusCode,
  ) {
    super(message);
  }
}

export function serviceStatusFromError(error: unknown): StatusCode | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  return serviceStatusFromResponse(error.response);
}

export function serviceStatusFromResponse(response: unknown): StatusCode | undefined {
  if (typeof response !== 'object' || response === null || !('responseHeader' in response))
    return undefined;
  const header = response.responseHeader;
  if (typeof header !== 'object' || header === null || !('serviceResult' in header))
    return undefined;
  return mapStatusCode(header.serviceResult);
}
