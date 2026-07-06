import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../../src/config/schema.js';
import { getReadEntryPoints, resolveReadEntryPointLabel } from '../../src/policy/read-entry-points.js';

const config = appConfigSchema.parse({
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
});

describe('Read Entry Point policy helpers', () => {
  it('resolves labels only from configured Read Entry Points', () => {
    expect(resolveReadEntryPointLabel(config, 'machine')).toBe('ns=2;s=Machine');
    expect(resolveReadEntryPointLabel(config, 'unknown')).toBeUndefined();
  });

  it('returns configured Read Entry Points without implying a permission boundary', () => {
    expect(getReadEntryPoints(config)).toEqual([{ nodeId: 'ns=2;s=Machine', label: 'machine' }]);
  });
});
