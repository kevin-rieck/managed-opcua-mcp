import { describe, expect, it } from 'vitest';
import { OpcUaInspectionService } from '../../src/opcua/inspection-module.js';
import type {
  ProtocolBrowsePage,
  ProtocolBrowseRequest,
  ProtocolDataValue,
  ProtocolReadRequest,
  ProtocolResult,
  ReadOnlyOpcUaProtocolAdapter,
  ReadOnlyOpcUaSessionLease,
} from '../../src/opcua/read-only-protocol.js';

const good = (value: unknown, dataType?: string): ProtocolDataValue => ({
  statusCode: 'Good',
  quality: 'good',
  value,
  ...(dataType === undefined ? {} : { dataType }),
});

describe('native inspection safety fixes', () => {
  it('keeps native browse pages behind replayable opaque cursors', async () => {
    const lease = new FindingsLease();
    const service = new OpcUaInspectionService(adapter(lease));

    const first = await service.browse({ selector: { nodeId: 'i=1' }, pageSize: 1 });
    expect(first).toMatchObject({ ok: true, complete: false, incompleteReasons: ['page_size'] });
    if (!first.ok || first.continuation === undefined) throw new Error('Expected a cursor.');
    expect(lease.browseNextCalls).toBe(0);

    const second = await service.browse({ continuation: first.continuation });
    const replay = await service.browse({ continuation: first.continuation });
    expect(second).toEqual(replay);
    expect(second).toMatchObject({
      ok: true,
      complete: true,
      edges: [{ target: { nodeId: 'ns=0;i=3' } }],
    });
    expect(lease.browseNextCalls).toBe(1);
  }, 15_000);

  it('reduces a rejected read batch for the active connection generation', async () => {
    const lease = new FindingsLease(true);
    const service = new OpcUaInspectionService(adapter(lease));

    const result = await service.read({ selectors: [{ nodeId: 'i=1' }, { nodeId: 'i=2' }] });

    expect(result.ok).toBe(true);
    expect(lease.readSizes).toEqual([2, 1, 1]);
  });

  it('bounds serialized read responses without truncating values', async () => {
    const lease = new FindingsLease(false, false, true);
    const service = new OpcUaInspectionService(adapter(lease), { maximumResponseBytes: 1_200 });

    const result = await service.read({ selector: { nodeId: 'i=1' } });

    expect(result).toMatchObject({
      ok: true,
      items: [{ value: { state: 'failed', code: 'response_limit_exceeded' } }],
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_200);
  });

  it('tags safe Int64 values and rejects unsafe numeric integers', async () => {
    const lease = new FindingsLease(false, true);
    const service = new OpcUaInspectionService(adapter(lease));

    const result = await service.read({ selectors: [{ nodeId: 'i=1' }, { nodeId: 'i=2' }] });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { value: { state: 'present', value: { type: 'Int64', value: '42' } } },
        { value: { state: 'unsupported', code: 'unsafe_integer' } },
      ],
    });
  });
});

class FindingsLease implements ReadOnlyOpcUaSessionLease {
  connectionGeneration = 1;
  browseNextCalls = 0;
  readonly readSizes: number[] = [];

  constructor(
    private readonly rejectLargeReads = false,
    private readonly unsafeInt64 = false,
    private readonly largeValue = false,
  ) {}

  browse(request: ProtocolBrowseRequest): Promise<ProtocolResult<ProtocolBrowsePage>> {
    return Promise.resolve({
      ok: true,
      value: {
        statusCode: 'Good',
        references: request.nodeId === 'ns=0;i=1' ? [reference('ns=0;i=2', 'Two')] : [],
        ...(request.nodeId === 'ns=0;i=1' ? { continuationPoint: new Uint8Array([1]) } : {}),
      },
    });
  }

  browseNext(): Promise<ProtocolResult<ProtocolBrowsePage>> {
    this.browseNextCalls += 1;
    return Promise.resolve({
      ok: true,
      value: { statusCode: 'Good', references: [reference('ns=0;i=3', 'Three')] },
    });
  }

  read(requests: ProtocolReadRequest[]): Promise<ProtocolResult<ProtocolDataValue[]>> {
    this.readSizes.push(requests.length);
    if (this.rejectLargeReads && requests.length > 1)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'server_busy',
          message: 'Too many operations.',
          statusCode: 'BadTooManyOperations',
        },
      });
    return Promise.resolve({
      ok: true,
      value: requests.map((request) => {
        if (request.attributeId !== 13) return good(undefined);
        return good(
          this.largeValue
            ? 'x'.repeat(5_000)
            : this.unsafeInt64 && request.nodeId === 'ns=0;i=2'
              ? 9_007_199_254_740_992
              : 42,
          this.unsafeInt64 ? '8' : '6',
        );
      }),
    });
  }

  readNamespaceArray(): Promise<ProtocolResult<string[]>> {
    return Promise.resolve({ ok: true, value: ['http://opcfoundation.org/UA/'] });
  }

  readOperationLimits(): Promise<ProtocolResult<{ maxNodesPerRead?: number }>> {
    return Promise.resolve({ ok: true, value: { maxNodesPerRead: 50 } });
  }

  releaseContinuationPoints(): Promise<ProtocolResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  assertGeneration(): void {
    return;
  }

  release(): void {
    return;
  }
}

function reference(nodeId: string, name: string) {
  return {
    nodeId,
    referenceTypeId: 'ns=0;i=47',
    isForward: true,
    browseName: { namespaceIndex: 0, name },
    displayName: { text: name },
    nodeClass: 1,
  };
}

function adapter(lease: FindingsLease): ReadOnlyOpcUaProtocolAdapter {
  return { acquireSession: () => Promise.resolve(lease) };
}
