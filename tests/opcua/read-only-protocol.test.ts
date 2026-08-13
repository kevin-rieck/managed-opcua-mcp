import { describe, expect, it, vi } from 'vitest';
import {
  GenerationScopedCache,
  NodeOpcUaReadOnlyAdapter,
  OpcUaProtocolError,
  runGenerationFenced,
  type NodeOpcUaDataValue,
  type NodeOpcUaReadOnlySession,
} from '../../src/opcua/read-only-protocol.js';

const good = { name: 'Good' };

describe('NodeOpcUaReadOnlyAdapter', () => {
  it('leases a generation and performs one true batch Read preserving order and duplicates', async () => {
    const readBatch = vi.fn(() =>
      Promise.resolve([
        { value: { dataType: 11, value: 21 }, statusCode: good },
        { value: { dataType: 11, value: 22 }, statusCode: { name: 'UncertainDataSubNormal' } },
        { statusCode: { name: 'BadUserAccessDenied' } },
      ]),
    );
    const source = connectedSource({ readBatch });
    const adapter = new NodeOpcUaReadOnlyAdapter(source);
    const lease = await adapter.acquireSession();

    await expect(
      lease.read([
        { nodeId: 'ns=2;s=A', attributeId: 13 },
        { nodeId: 'ns=2;s=A', attributeId: 13 },
        { nodeId: 'ns=2;s=Denied', attributeId: 13 },
      ]),
    ).resolves.toEqual({
      ok: true,
      value: [
        expect.objectContaining({ statusCode: 'Good', quality: 'good', value: 21 }),
        expect.objectContaining({
          statusCode: 'UncertainDataSubNormal',
          quality: 'uncertain',
          value: 22,
        }),
        expect.objectContaining({ statusCode: 'BadUserAccessDenied', quality: 'bad' }),
      ],
    });
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBatch).toHaveBeenCalledWith([
      { nodeId: 'ns=2;s=A', attributeId: 13 },
      { nodeId: 'ns=2;s=A', attributeId: 13 },
      { nodeId: 'ns=2;s=Denied', attributeId: 13 },
    ]);
  });

  it('does not start native work for a pre-cancelled operation', async () => {
    const readBatch = vi.fn(() => Promise.resolve([]));
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ readBatch }));
    const lease = await adapter.acquireSession();
    const controller = new AbortController();
    controller.abort();

    await expect(
      lease.read([{ nodeId: 'i=1', attributeId: 13 }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'operation_cancelled' });
    expect(readBatch).not.toHaveBeenCalled();
  });

  it('maps exact bad statuses to stable canonical protocol failures', async () => {
    const adapter = new NodeOpcUaReadOnlyAdapter(
      connectedSource({
        browse: vi.fn(() =>
          Promise.resolve({ statusCode: { name: 'BadUserAccessDenied' }, references: [] }),
        ),
      }),
    );
    const lease = await adapter.acquireSession();

    await expect(lease.browse(browseRequest())).resolves.toEqual({
      ok: false,
      error: {
        code: 'opcua_access_denied',
        message: 'The OPC UA Server denied the operation.',
        statusCode: 'BadUserAccessDenied',
      },
    });
  });

  it('maps Browse status and native continuation points to canonical outcomes', async () => {
    const continuationPoint = new Uint8Array([1, 2, 3]);
    const browse = vi.fn(() =>
      Promise.resolve({
        statusCode: good,
        continuationPoint,
        references: [
          {
            nodeId: { toString: () => 'ns=2;s=Target' },
            referenceTypeId: { toString: () => 'i=35' },
            isForward: false,
            browseName: { namespaceIndex: 2, name: 'Target' },
            displayName: { locale: 'en', text: 'Target node' },
            nodeClass: 2,
            typeDefinition: { toString: () => 'i=63' },
          },
        ],
      }),
    );
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ browse }));
    const lease = await adapter.acquireSession();

    const result = await lease.browse({
      nodeId: 'ns=2;s=Start',
      direction: 'inverse',
      referenceTypeId: 'i=33',
      includeSubtypes: true,
      nodeClassMask: 0,
      requestedMaxReferencesPerNode: 100,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        statusCode: 'Good',
        continuationPoint,
        references: [
          {
            nodeId: 'ns=2;s=Target',
            referenceTypeId: 'i=35',
            isForward: false,
            browseName: { namespaceIndex: 2, name: 'Target' },
            displayName: { locale: 'en', text: 'Target node' },
            nodeClass: 2,
            typeDefinition: 'i=63',
          },
        ],
      },
    });
    expect(result.ok && result.value.continuationPoint).not.toBe(continuationPoint);
    continuationPoint[0] = 99;
    expect(result.ok && result.value.continuationPoint?.[0]).toBe(1);
  });

  it('releases native continuation points using BrowseNext release semantics', async () => {
    const browseNext = vi.fn(() => Promise.resolve({ statusCode: good, references: [] }));
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ browseNext }));
    const lease = await adapter.acquireSession();
    const points = [new Uint8Array([1]), new Uint8Array([2])];

    await expect(lease.releaseContinuationPoints(points)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(browseNext).toHaveBeenCalledWith(points, true);
  });

  it('releases the input continuation point when BrowseNext fails', async () => {
    const point = new Uint8Array([7]);
    const browseNext = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport details'))
      .mockResolvedValueOnce({ statusCode: good, references: [] });
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ browseNext }));
    const lease = await adapter.acquireSession();

    await expect(lease.browseNext(point)).rejects.toMatchObject({
      code: 'opcua_operation_failed',
    });
    await flushPromises();

    expect(browseNext).toHaveBeenNthCalledWith(1, [point], false);
    expect(browseNext).toHaveBeenNthCalledWith(2, [point], true);
  });

  it('maps namespace and Server operation-limit reads through protocol primitives', async () => {
    const readBatch = vi
      .fn()
      .mockResolvedValueOnce([
        {
          statusCode: good,
          value: { value: ['http://opcfoundation.org/UA/', 'urn:example:plant'] },
        },
      ])
      .mockResolvedValueOnce([
        { statusCode: good, value: { value: 250 } },
        { statusCode: good, value: { value: 75 } },
      ]);
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ readBatch }));
    const lease = await adapter.acquireSession();

    await expect(lease.readNamespaceArray()).resolves.toEqual({
      ok: true,
      value: ['http://opcfoundation.org/UA/', 'urn:example:plant'],
    });
    await expect(lease.readOperationLimits()).resolves.toEqual({
      ok: true,
      value: { maxNodesPerRead: 250, maxNodesPerBrowse: 75 },
    });
    expect(readBatch).toHaveBeenNthCalledWith(1, [{ nodeId: 'i=2255', attributeId: 13 }]);
    expect(readBatch).toHaveBeenNthCalledWith(2, [
      { nodeId: 'i=11705', attributeId: 13 },
      { nodeId: 'i=11710', attributeId: 13 },
    ]);
  });

  it('fails a whole generation-fenced operation when the connection changes', async () => {
    let generation = 4;
    const adapter = new NodeOpcUaReadOnlyAdapter(
      connectedSource({ readBatch: vi.fn(() => Promise.resolve([])) }, () => generation),
    );

    await expect(
      runGenerationFenced(adapter, (lease) => {
        expect(lease.connectionGeneration).toBe(4);
        generation = 5;
        return Promise.resolve('late data');
      }),
    ).rejects.toMatchObject({ code: 'connection_changed' });
  });

  it('reports a generation change instead of a stale native rejection', async () => {
    let generation = 4;
    let rejectRead: ((error: Error) => void) | undefined;
    const readBatch = vi.fn(
      () =>
        new Promise<NodeOpcUaDataValue[]>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ readBatch }, () => generation));
    const lease = await adapter.acquireSession();
    const pending = lease.read([{ nodeId: 'i=1', attributeId: 13 }]);

    generation = 5;
    rejectRead?.(new Error('old session closed'));

    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' });
  });

  it('cancels without closing the shared session and releases a late Browse continuation', async () => {
    let resolveBrowse: ((value: object) => void) | undefined;
    const browse = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          resolveBrowse = resolve;
        }),
    );
    const browseNext = vi.fn(() => Promise.resolve({ statusCode: good, references: [] }));
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ browse, browseNext }));
    const lease = await adapter.acquireSession();
    const controller = new AbortController();
    const pending = lease.browse(browseRequest(), { signal: controller.signal });

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'operation_cancelled' });
    resolveBrowse?.({
      statusCode: good,
      references: [],
      continuationPoint: new Uint8Array([9]),
    });
    await flushPromises();

    expect('close' in lease).toBe(false);
    expect(browseNext).toHaveBeenCalledWith([new Uint8Array([9])], true);
  });

  it('enforces deadlines with stable sanitized errors', async () => {
    vi.useFakeTimers();
    const readBatch = vi.fn(() => new Promise<NodeOpcUaDataValue[]>(() => undefined));
    const adapter = new NodeOpcUaReadOnlyAdapter(connectedSource({ readBatch }));
    const lease = await adapter.acquireSession();
    const pending = lease.read([{ nodeId: 'i=1', attributeId: 13 }], {
      deadlineAt: Date.now() + 1_000,
    });

    const rejection = expect(pending).rejects.toEqual(
      new OpcUaProtocolError('operation_timeout', 'The OPC UA operation timed out.'),
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;
    vi.useRealTimers();
  });
});

describe('GenerationScopedCache', () => {
  it('never returns values from another connection generation', () => {
    const cache = new GenerationScopedCache<string, string>();
    cache.set(2, 'namespace:2', 'urn:old');

    expect(cache.get(2, 'namespace:2')).toBe('urn:old');
    expect(cache.get(3, 'namespace:2')).toBeUndefined();
    cache.set(3, 'namespace:2', 'urn:new');
    expect(cache.get(2, 'namespace:2')).toBeUndefined();
    expect(cache.get(3, 'namespace:2')).toBe('urn:new');
  });

  it('coalesces same-generation loads and rejects stale in-flight cache writes', async () => {
    const cache = new GenerationScopedCache<string, string>();
    let resolveOld: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
    );
    let currentGeneration = 1;

    const first = cache.getOrLoad(1, 'namespace:2', () => currentGeneration === 1, loader);
    const second = cache.getOrLoad(1, 'namespace:2', () => currentGeneration === 1, loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);

    currentGeneration = 2;
    cache.set(2, 'namespace:2', 'urn:new');
    resolveOld?.('urn:old');

    await expect(first).resolves.toBeUndefined();
    expect(cache.get(2, 'namespace:2')).toBe('urn:new');
  });

  it('removes rejected loads so they can be retried and supports explicit shutdown clearing', async () => {
    const cache = new GenerationScopedCache<string, string>();
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('urn:retry');

    await expect(cache.getOrLoad(3, 'namespace:3', () => true, loader)).rejects.toThrow(
      'temporary failure',
    );
    await expect(cache.getOrLoad(3, 'namespace:3', () => true, loader)).resolves.toBe('urn:retry');
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get(3, 'namespace:3')).toBeUndefined();
  });
});

function connectedSource(
  session: Partial<NodeOpcUaReadOnlySession>,
  currentGeneration: () => number = () => 1,
) {
  const completeSession: NodeOpcUaReadOnlySession = {
    browse: session.browse ?? vi.fn(() => Promise.resolve({ statusCode: good, references: [] })),
    browseNext:
      session.browseNext ?? vi.fn(() => Promise.resolve({ statusCode: good, references: [] })),
    readBatch: session.readBatch ?? vi.fn(() => Promise.resolve([])),
  };
  return {
    currentGeneration,
    sessionSnapshot: () => ({
      session: completeSession,
      connectionGeneration: currentGeneration(),
    }),
  };
}

function browseRequest() {
  return {
    nodeId: 'i=84',
    direction: 'forward' as const,
    referenceTypeId: 'i=33',
    includeSubtypes: true,
    nodeClassMask: 0,
    requestedMaxReferencesPerNode: 100,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
