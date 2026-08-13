import { describe, expect, it, vi } from 'vitest';
import type {
  BrowseRequest,
  InspectionFailure,
  OpcUaInspectionModule,
  ReadResult,
} from '../../src/opcua/inspection-contracts.js';
import {
  validateNodeSelector,
  validateNodeSelectorBatch,
} from '../../src/opcua/selector-validation.js';

describe('inspection public contracts', () => {
  it('supports concrete request and result contracts without depending on control capabilities', async () => {
    const failure: InspectionFailure = {
      ok: false,
      error: { code: 'operation_cancelled', message: 'The operation was cancelled.' },
    };
    const module: OpcUaInspectionModule = {
      browse: vi.fn(() => Promise.resolve(failure)),
      inspect: vi.fn(() => Promise.resolve(failure)),
      read: vi.fn(() => Promise.resolve(failure)),
      modelContext: vi.fn(() => Promise.resolve(failure)),
    };
    const request: BrowseRequest = { selector: { nodeId: 'ns=2;s=Machine' } };

    await expect(module.browse(request)).resolves.toEqual(failure);
    expect('write' in module).toBe(false);
  });

  it('represents a successful batch read with correlation, quality, and conversion outcome', () => {
    const result: ReadResult = {
      ok: true,
      observedAt: '2026-08-13T12:00:00.000Z',
      connectionGeneration: 7,
      items: [
        {
          index: 0,
          selector: { nodeId: 'ns=2;s=Temperature' },
          state: 'success',
          identity: {
            nodeId: 'ns=2;s=Temperature',
            namespaceIndex: 2,
            namespaceUri: { state: 'present', value: 'urn:example:plant' },
          },
          statusCode: 'Good',
          quality: 'good',
          usable: true,
          dataType: {
            state: 'present',
            value: {
              nodeId: 'ns=0;i=11',
              namespaceIndex: 0,
              namespaceUri: { state: 'present', value: 'http://opcfoundation.org/UA/' },
              name: { state: 'present', value: 'Double' },
            },
          },
          value: { state: 'present', value: 72.5 },
          conversion: { state: 'converted' },
          sourceTimestamp: '2026-08-13T11:59:59.000Z',
        },
      ],
    };

    const first = result.items[0];
    expect(first?.state).toBe('success');
    if (first?.state !== 'success') throw new Error('Expected a successful read item.');
    expect(first.quality).toBe('good');
  });

  it('represents Bad values without requiring a datatype or dropping timestamps', () => {
    const result: ReadResult = {
      ok: true,
      observedAt: '2026-08-13T12:00:00.000Z',
      connectionGeneration: 7,
      items: [
        {
          index: 0,
          selector: { nodeId: 'ns=2;s=Denied' },
          state: 'partial',
          identity: {
            nodeId: 'ns=2;s=Denied',
            namespaceIndex: 2,
            namespaceUri: {
              state: 'failed',
              code: 'namespace_unavailable',
              message: 'Unavailable.',
            },
          },
          dataType: { state: 'not_present' },
          statusCode: 'BadUserAccessDenied',
          quality: 'bad',
          usable: false,
          value: { state: 'denied', code: 'opcua_access_denied', message: 'Denied.' },
          conversion: { state: 'failed', code: 'value_unavailable', message: 'Unavailable.' },
          serverTimestamp: '2026-08-13T12:00:00.000Z',
        },
      ],
    };

    expect(result.items[0]).toMatchObject({ quality: 'bad', usable: false });
  });
});

describe('Node selector validation', () => {
  it('parses and canonicalizes NodeIds before protocol use', () => {
    const parser = vi.fn(() => 'ns=2;s=Machine');

    expect(validateNodeSelector({ nodeId: 'ns=2;s=Machine' }, parser)).toEqual({
      ok: true,
      selector: { nodeId: 'ns=2;s=Machine' },
      canonicalNodeId: 'ns=2;s=Machine',
    });
    expect(parser).toHaveBeenCalledWith('ns=2;s=Machine');
  });

  it('preserves significant whitespace in string NodeIds', () => {
    const parser = vi.fn((value: string) => value);

    expect(validateNodeSelector({ nodeId: 'ns=2;s= Machine ' }, parser)).toMatchObject({
      ok: true,
      canonicalNodeId: 'ns=2;s= Machine ',
    });
    expect(parser).toHaveBeenCalledWith('ns=2;s= Machine ');
  });

  it('correlates malformed and conflicting selectors while retaining valid selectors', () => {
    const parser = (value: string): string => {
      if (value === 'bad') throw new Error('native parser detail');
      return value;
    };

    const result = validateNodeSelectorBatch(
      [
        { nodeId: 'ns=2;s=Good' },
        { nodeId: 'bad' },
        { label: 'Boiler' },
        { nodeId: 'ns=2;s=Conflict', label: 'Control name' } as never,
      ],
      {
        maximumBatchSize: 10,
        parseNodeId: parser,
        resolveLabel: (label) => (label === 'Boiler' ? 'ns=2;s=Boiler' : undefined),
      },
    );

    expect(result).toEqual({
      ok: true,
      items: [
        {
          index: 0,
          selector: { nodeId: 'ns=2;s=Good' },
          validation: {
            ok: true,
            selector: { nodeId: 'ns=2;s=Good' },
            canonicalNodeId: 'ns=2;s=Good',
          },
        },
        {
          index: 1,
          selector: { nodeId: 'bad' },
          validation: {
            ok: false,
            error: { code: 'invalid_selector', message: 'The selector NodeId is invalid.' },
          },
        },
        {
          index: 2,
          selector: { label: 'Boiler' },
          validation: {
            ok: true,
            selector: { label: 'Boiler' },
            canonicalNodeId: 'ns=2;s=Boiler',
            resolvedFromLabel: 'Boiler',
          },
        },
        {
          index: 3,
          selector: { nodeId: 'ns=2;s=Conflict', label: 'Control name' },
          validation: {
            ok: false,
            error: {
              code: 'invalid_selector',
              message: 'A selector must contain exactly one of nodeId or label.',
            },
          },
        },
      ],
    });
  });

  it('rejects labels outside configured Read Entry Points, including Control names', () => {
    const result = validateNodeSelectorBatch([{ label: 'EmergencyStopControl' }], {
      maximumBatchSize: 10,
      parseNodeId: (value) => value,
      resolveLabel: () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      items: [
        {
          index: 0,
          selector: { label: 'EmergencyStopControl' },
          validation: {
            ok: false,
            error: {
              code: 'invalid_selector',
              message: 'The selector label is not a configured Read Entry Point.',
            },
          },
        },
      ],
    });
  });

  it('rejects invalid batch envelopes before parsing any selector', () => {
    const parser = vi.fn((value: string) => value);

    expect(validateNodeSelectorBatch([], { maximumBatchSize: 2, parseNodeId: parser })).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'At least one selector is required.' },
    });
    expect(
      validateNodeSelectorBatch([{ nodeId: 'i=1' }, { nodeId: 'i=2' }, { nodeId: 'i=3' }], {
        maximumBatchSize: 2,
        parseNodeId: parser,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'request_limit_exceeded',
        message: 'The selector batch exceeds the maximum of 2 items.',
      },
    });
    expect(parser).not.toHaveBeenCalled();
  });

  it('measures the NodeId limit in Unicode scalar values', () => {
    const parser = vi.fn((value: string) => value);
    const maximum = `s=${'😀'.repeat(4_094)}`;

    expect(validateNodeSelector({ nodeId: maximum }, parser).ok).toBe(true);
    expect(validateNodeSelector({ nodeId: `${maximum}😀` }, parser)).toMatchObject({
      ok: false,
      error: { code: 'invalid_selector' },
    });
  });

  it('enforces the NodeId Unicode scalar limit', () => {
    const parser = vi.fn((value: string) => value);
    const result = validateNodeSelector({ nodeId: 'a'.repeat(4_097) }, parser);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_selector',
        message: 'The selector NodeId exceeds 4096 Unicode scalar values.',
      },
    });
    expect(parser).not.toHaveBeenCalled();
  });
});
