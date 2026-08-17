import { describe, expect, it } from 'vitest';
import { validateNodeSelector } from '../../src/inspection/common.js';

describe('inspection selector validation', () => {
  it('accepts exactly one bounded NodeId or Read Entry Point label', () => {
    expect(validateNodeSelector({ nodeId: 'ns=2;s=Machine' })).toEqual({
      ok: true,
      selector: { nodeId: 'ns=2;s=Machine' },
    });
    expect(validateNodeSelector({ label: 'machine' })).toEqual({
      ok: true,
      selector: { label: 'machine' },
    });
    expect(validateNodeSelector({})).toMatchObject({ ok: false, code: 'missing_selector' });
    expect(
      validateNodeSelector({ nodeId: 'ns=2;s=Machine', label: 'machine' }),
    ).toMatchObject({ ok: false, code: 'conflicting_selector' });
    expect(validateNodeSelector({ nodeId: 'x'.repeat(4_097) })).toMatchObject({
      ok: false,
      code: 'invalid_node_id',
    });
    expect(validateNodeSelector({ nodeId: 'not-a-node-id' })).toMatchObject({
      ok: false,
      code: 'invalid_node_id',
    });
  });
});
