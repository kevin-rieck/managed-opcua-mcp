import { describe, expect, it } from 'vitest';
import {
  OpcUaInspectionService,
  type OpcUaInspectionModuleOptions,
} from '../../src/opcua/inspection-module.js';
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

class FakeLease implements ReadOnlyOpcUaSessionLease {
  connectionGeneration = 1;
  readonly readCalls: ProtocolReadRequest[][] = [];
  namespaceResult: ProtocolResult<string[]> = {
    ok: true,
    value: ['http://opcfoundation.org/UA/', 'urn:fixture:one', 'urn:fixture:two'],
  };
  private readonly reads = new Map<string, ProtocolDataValue>();
  private readonly browses = new Map<string, ProtocolBrowsePage>();

  constructor() {
    this.browses.set('ns=0;i=11715', {
      statusCode: 'Good',
      references: [ref('ns=2;s=metadata', 'urn:fixture:one')],
    });
    this.browses.set('ns=2;s=metadata', {
      statusCode: 'Good',
      references: [
        ref('ns=2;s=metadata-uri', 'NamespaceUri'),
        ref('ns=2;s=metadata-version', 'NamespaceVersion'),
        ref('ns=2;s=metadata-date', 'NamespacePublicationDate'),
      ],
    });
    this.reads.set('ns=2;s=metadata-uri', good('urn:fixture:one'));
    this.reads.set('ns=2;s=metadata-version', good('2026.08'));
    this.reads.set('ns=2;s=metadata-date', good(new Date('2026-08-01T00:00:00.000Z')));
    this.reads.set('ns=2;s=value', good(42, '11'));
  }

  browse(request: ProtocolBrowseRequest): Promise<ProtocolResult<ProtocolBrowsePage>> {
    if (request.nodeId === 'ns=2;s=value')
      return Promise.resolve({ ok: true, value: { statusCode: 'Good', references: [] } });
    return Promise.resolve({
      ok: true,
      value: this.browses.get(request.nodeId) ?? { statusCode: 'Good', references: [] },
    });
  }

  browseNext(): Promise<ProtocolResult<ProtocolBrowsePage>> {
    return Promise.resolve({ ok: true, value: { statusCode: 'Good', references: [] } });
  }

  read(requests: ProtocolReadRequest[]): Promise<ProtocolResult<ProtocolDataValue[]>> {
    this.readCalls.push(requests);
    return Promise.resolve({
      ok: true,
      value: requests.map((request) => this.reads.get(request.nodeId) ?? good(undefined)),
    });
  }

  readNamespaceArray(): Promise<ProtocolResult<string[]>> {
    return Promise.resolve(this.namespaceResult);
  }

  readOperationLimits(): Promise<ProtocolResult<Record<string, never>>> {
    return Promise.resolve({ ok: true, value: {} });
  }

  releaseContinuationPoints(): Promise<ProtocolResult<void>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  assertGeneration(): void {
    // The fake remains on one connection generation.
  }

  release(): void {
    // The fake lease has no native resources.
  }
}

function ref(nodeId: string, name: string) {
  return {
    nodeId,
    referenceTypeId: 'i=47',
    isForward: true,
    browseName: { namespaceIndex: nodeId.startsWith('ns=2') ? 2 : 0, name },
  };
}

function adapter(lease: FakeLease): ReadOnlyOpcUaProtocolAdapter {
  return { acquireSession: () => Promise.resolve(lease) };
}

describe('OpcUaInspectionService model context and qualification', () => {
  it('retains indexed identity when namespace URI resolution fails', async () => {
    const lease = new FakeLease();
    lease.namespaceResult = {
      ok: false,
      error: { code: 'opcua_access_denied', message: 'Denied.' },
    };
    const service = new OpcUaInspectionService(adapter(lease));

    const result = await service.read({ selector: { nodeId: 'ns=2;s=value' } });

    expect(result).toMatchObject({
      ok: true,
      items: [
        {
          identity: {
            nodeId: 'ns=2;s=value',
            namespaceIndex: 2,
            namespaceUri: { state: 'failed', code: 'namespace_unavailable' },
          },
        },
      ],
    });
  }, 15_000);

  it('returns explicit NamespaceMetadata field outcomes and keeps missing metadata non-fatal', async () => {
    const service = new OpcUaInspectionService(adapter(new FakeLease()), {
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    const result = await service.modelContext();

    expect(result).toMatchObject({
      ok: true,
      observedAt: '2026-08-25T00:00:00.000Z',
      connectionGeneration: 1,
      complete: true,
      namespaces: [
        {
          namespaceIndex: 0,
          metadata: { state: 'not_present' },
        },
        {
          namespaceIndex: 1,
          namespaceUri: { state: 'present', value: 'urn:fixture:one' },
          metadata: {
            state: 'present',
            value: {
              modelUri: { state: 'present', value: 'urn:fixture:one' },
              version: { state: 'present', value: '2026.08' },
              publicationDate: { state: 'present', value: '2026-08-01T00:00:00.000Z' },
            },
          },
        },
        { namespaceIndex: 2, metadata: { state: 'not_present' } },
      ],
    });
  });

  it('returns only complete namespace entries when the response bound is reached', async () => {
    const options: OpcUaInspectionModuleOptions = { maximumResponseBytes: 500 };
    const service = new OpcUaInspectionService(adapter(new FakeLease()), options);

    const result = await service.modelContext();

    expect(result).toMatchObject({ ok: true, complete: false, limitReason: 'response_size' });
    if (!result.ok) throw new Error('Expected model context success.');
    expect(result.namespaces.length).toBeLessThan(3);
    expect(result).not.toHaveProperty('continuation');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(500);
  });
});
