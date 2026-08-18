import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS,
  OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS,
  startOpcUaInspectionFixture,
  type OpcUaInspectionFixture,
} from './opcua-inspection-fixture.js';

interface StatusCodeLike {
  name?: string;
  toString(): string;
}

interface DataValueLike {
  statusCode: StatusCodeLike;
  value?: { value?: unknown };
}

interface BrowseReferenceLike {
  browseName?: { name?: string };
  nodeId: { toString(): string };
}

interface BrowseResultLike {
  continuationPoint?: Uint8Array;
  references?: BrowseReferenceLike[];
}

interface OpcUaSessionLike {
  requestedMaxReferencesPerNode: number;
  close(): Promise<void>;
  browse(request: unknown): Promise<BrowseResultLike>;
  browseNext(
    continuationPoint: Uint8Array,
    release: boolean,
  ): Promise<BrowseResultLike | BrowseResultLike[]>;
  read(request: unknown): Promise<DataValueLike[]>;
}

interface OpcUaClientLike {
  connect(endpointUrl: string): Promise<void>;
  createSession(): Promise<OpcUaSessionLike>;
  disconnect(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { BrowseDirection, OPCUAClient } = require('node-opcua') as {
  BrowseDirection: { Forward: unknown; Inverse: unknown };
  OPCUAClient: { create(options: Record<string, unknown>): OpcUaClientLike };
};
const fixtures: OpcUaInspectionFixture[] = [];
let fixture: OpcUaInspectionFixture;

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await Promise.all(fixtures.splice(0).map((activeFixture) => activeFixture.close()));
});

describe('in-process OPC UA inspection fixture', () => {
  it('starts a deterministic anonymous Server with stable entry-point NodeIds', async () => {
    expect(fixture.endpointUrl).toMatch(/^opc\.tcp:\/\/127\.0\.0\.1:\d+$/u);
    expect(fixture.nodeIds.hierarchy.root).toBe('ns=2;s=Fixture.Hierarchy.Root');
    expect(fixture.nodeIds.sparse.root).toBe('ns=3;s=Fixture.Sparse.Root');
    expect(fixture.namespaceUris).toEqual(OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS);
    expect(fixture.operationLimits).toEqual(OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS);

    await withSession(fixture, async (session) => {
      const references = await session.browse(fixture.nodeIds.hierarchy.root);
      expect(nodeIds(references)).toContain(fixture.nodeIds.hierarchy.area);
    });
  });

  it('provides hierarchical and sparse references, repetition, cycles, and native continuations', async () => {
    await withSession(fixture, async (session) => {
      const inverse = await session.browse({
        nodeId: fixture.nodeIds.hierarchy.area,
        browseDirection: BrowseDirection.Inverse,
        referenceTypeId: 'HierarchicalReferences',
        includeSubtypes: true,
        resultMask: 63,
      });
      expect(nodeIds(inverse)).toContain(fixture.nodeIds.hierarchy.root);

      const repeated = await browseForward(
        session,
        fixture.nodeIds.hierarchy.repeatedSource,
        'References',
      );
      expect(
        nodeIds(repeated).filter((nodeId) => nodeId === fixture.nodeIds.hierarchy.repeatedTarget),
      ).toHaveLength(2);

      const cycle = await browseForward(
        session,
        fixture.nodeIds.hierarchy.cycleEnd,
        'HierarchicalReferences',
      );
      expect(nodeIds(cycle)).toContain(fixture.nodeIds.hierarchy.cycleStart);

      const sparseHierarchical = await browseForward(
        session,
        fixture.nodeIds.sparse.root,
        'HierarchicalReferences',
      );
      expect(nodeIds(sparseHierarchical)).not.toContain(fixture.nodeIds.sparse.source);
      const sparseAll = await browseForward(session, fixture.nodeIds.sparse.root, 'References');
      expect(nodeIds(sparseAll)).toContain(fixture.nodeIds.sparse.source);
      expect(
        sparseAll.references
          ?.find((reference) => reference.nodeId.toString() === fixture.nodeIds.sparse.source)
          ?.nodeId.toString(),
      ).toBe(fixture.nodeIds.sparse.source);

      session.requestedMaxReferencesPerNode = 2;
      const firstPage = await session.browse({
        nodeId: fixture.nodeIds.hierarchy.continuationSource,
        browseDirection: BrowseDirection.Forward,
        referenceTypeId: 'HierarchicalReferences',
        includeSubtypes: true,
        resultMask: 63,
      });
      expect(firstPage.references).toHaveLength(2);
      expect(firstPage.continuationPoint).toBeInstanceOf(Uint8Array);
      const nextPage = firstBrowseResult(
        await session.browseNext(requireContinuation(firstPage), false),
      );
      expect(nextPage.references).toHaveLength(2);
      expect(nextPage.continuationPoint).toBeInstanceOf(Uint8Array);
    });
  });

  it('supplies protocol values, diagnostic variants, namespace metadata, and advertised limits', async () => {
    await withSession(fixture, async (session) => {
      const values = await session.read([
        { nodeId: fixture.nodeIds.values.good, attributeId: 13 },
        { nodeId: fixture.nodeIds.values.uncertain, attributeId: 13 },
      ]);
      expect(statusName(values[0])).toBe('Good');
      expect(values[0]?.value?.value).toBe(21.5);
      expect(statusName(values[1])).toBe('UncertainLastUsableValue');
      expect(values[1]?.value?.value).toBe(20.5);

      const failedValues = await session.read([
        { nodeId: fixture.nodeIds.values.bad, attributeId: 13 },
        { nodeId: fixture.nodeIds.values.denied, attributeId: 13 },
      ]);
      expect(statusName(failedValues[0])).toBe('BadNoDataAvailable');
      expect(statusName(failedValues[1])).toBe('BadUserAccessDenied');

      const encodedValues = await session.read([
        { nodeId: fixture.nodeIds.values.byteString, attributeId: 13 },
        { nodeId: fixture.nodeIds.values.localizedText, attributeId: 13 },
      ]);
      expect(encodedValues[0]?.value?.value).toBeInstanceOf(Buffer);
      expect(encodedValues[1]?.value?.value).toMatchObject({
        locale: 'en-US',
        text: 'Fixture text',
      });
      await expectGoodValues(session, [
        fixture.nodeIds.values.boolean,
        fixture.nodeIds.values.safeInteger,
        fixture.nodeIds.values.float,
        fixture.nodeIds.values.string,
        fixture.nodeIds.values.int64,
        fixture.nodeIds.values.uint64,
        fixture.nodeIds.values.byteString,
        fixture.nodeIds.values.dateTime,
        fixture.nodeIds.values.guid,
        fixture.nodeIds.values.nodeId,
        fixture.nodeIds.values.expandedNodeId,
        fixture.nodeIds.values.qualifiedName,
        fixture.nodeIds.values.localizedText,
        fixture.nodeIds.values.null,
        fixture.nodeIds.values.doubleArray,
        fixture.nodeIds.values.stringArray,
        fixture.nodeIds.values.matrix,
        fixture.nodeIds.values.extensionObject,
      ]);
      const finiteAndNonFiniteValues = await session.read([
        { nodeId: fixture.nodeIds.values.float, attributeId: 13 },
        { nodeId: fixture.nodeIds.values.nan, attributeId: 13 },
      ]);
      expect(finiteAndNonFiniteValues[0]?.value?.value).toBe(12.5);
      expect(Number.isNaN(finiteAndNonFiniteValues[1]?.value?.value)).toBe(true);
      const infinityValues = await session.read([
        { nodeId: fixture.nodeIds.values.positiveInfinity, attributeId: 13 },
        { nodeId: fixture.nodeIds.values.negativeInfinity, attributeId: 13 },
      ]);
      expect(infinityValues[0]?.value?.value).toBe(Infinity);
      expect(infinityValues[1]?.value?.value).toBe(-Infinity);

      const properties = await browseForward(
        session,
        fixture.nodeIds.diagnostics.valid,
        'HasProperty',
      );
      expect(propertyNames(properties)).toEqual(
        expect.arrayContaining([
          'EngineeringUnits',
          'EURange',
          'InstrumentRange',
          'EnumStrings',
          'EnumValues',
        ]),
      );
      expect(
        propertyNames(
          await browseForward(session, fixture.nodeIds.diagnostics.missing, 'HasProperty'),
        ),
      ).toEqual([]);
      expect(
        propertyNames(
          await browseForward(session, fixture.nodeIds.diagnostics.ambiguous, 'HasProperty'),
        ).filter((name) => name === 'EURange'),
      ).toHaveLength(2);

      const diagnosticValues = await session.read([
        { nodeId: fixture.nodeIds.diagnostics.properties.oversizedEnumStrings, attributeId: 13 },
        { nodeId: fixture.nodeIds.diagnostics.properties.deniedEngineeringUnits, attributeId: 13 },
      ]);
      expect(diagnosticValues[0]?.value?.value).toHaveLength(1_001);
      expect(statusName(diagnosticValues[1])).toBe('BadUserAccessDenied');
      const enumValues = await session.read([
        { nodeId: fixture.nodeIds.diagnostics.properties.validEnumValues, attributeId: 13 },
      ]);
      expect(enumValues[0]?.value?.value).toHaveLength(2);
      const unsupportedDiagnostic = await session.read([
        {
          nodeId: fixture.nodeIds.diagnostics.properties.unsupportedEngineeringUnits,
          attributeId: 13,
        },
      ]);
      expect(statusName(unsupportedDiagnostic[0])).toBe('Good');
      expect(unsupportedDiagnostic[0]?.value?.value).toMatchObject({
        name: 'Unsupported fixture ExtensionObject',
      });

      const metadata = await session.read([
        { nodeId: 'i=2255', attributeId: 13 },
        { nodeId: 'i=11705', attributeId: 13 },
      ]);
      expect(metadata[0]?.value?.value).toEqual(
        expect.arrayContaining([
          OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.hierarchy,
          OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.sparse,
        ]),
      );
      expect(metadata[1]?.value?.value).toBe(
        OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS.maxNodesPerRead,
      );
      const namespaceMetadata = await browseForward(session, 'i=11715', 'HasComponent');
      const hierarchyMetadata = (namespaceMetadata.references ?? []).find(
        (reference) =>
          reference.browseName?.name === OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.hierarchy,
      );
      expect(hierarchyMetadata).toBeDefined();
      if (hierarchyMetadata === undefined) throw new Error('Expected hierarchy NamespaceMetadata.');
      expect(
        propertyNames(
          await browseForward(session, hierarchyMetadata.nodeId.toString(), 'HasProperty'),
        ),
      ).toEqual(
        expect.arrayContaining(['NamespaceUri', 'NamespaceVersion', 'NamespacePublicationDate']),
      );
      const browseLimit = await session.read([{ nodeId: 'i=11710', attributeId: 13 }]);
      expect(browseLimit[0]?.value?.value).toBe(
        OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS.maxNodesPerBrowse,
      );
    });
  });

  it('resets forced outcomes across a restart and isolated fixture run', async () => {
    const originalEndpoint = fixture.endpointUrl;
    fixture.setReadOutcome(fixture.nodeIds.values.good, 'failed');

    await withSession(fixture, async (session) => {
      const result = await session.read([{ nodeId: fixture.nodeIds.values.good, attributeId: 13 }]);
      expect(statusName(result[0])).toBe('BadInternalError');
    });

    await expectSameClientToReconnectAfterRestart(fixture);
    expect(fixture.endpointUrl).toBe(originalEndpoint);
    expect(fixture.nodeIds.values.good).toBe('ns=2;s=Fixture.Value.Good');

    await fixture.close();
    expect(fixture.running).toBe(false);
    await expectEndpointPortReleased(originalEndpoint);
    const isolatedFixture = await startFixture();
    expect(isolatedFixture.endpointUrl).not.toBe(originalEndpoint);
    await withSession(isolatedFixture, async (session) => {
      const result = await session.read([
        { nodeId: isolatedFixture.nodeIds.values.good, attributeId: 13 },
      ]);
      expect(statusName(result[0])).toBe('Good');
    });
  });
});

async function startFixture(): Promise<OpcUaInspectionFixture> {
  const fixture = await startOpcUaInspectionFixture();
  fixtures.push(fixture);
  return fixture;
}

async function withSession(
  fixture: OpcUaInspectionFixture,
  operation: (session: OpcUaSessionLike) => Promise<void>,
): Promise<void> {
  const client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect(fixture.endpointUrl);
  const session = await client.createSession();
  try {
    await operation(session);
  } finally {
    await session.close();
    await client.disconnect();
  }
}

async function expectSameClientToReconnectAfterRestart(
  fixture: OpcUaInspectionFixture,
): Promise<void> {
  const client = OPCUAClient.create({ endpointMustExist: false });
  let session: OpcUaSessionLike | undefined;
  let reconnectedSession: OpcUaSessionLike | undefined;
  try {
    await client.connect(fixture.endpointUrl);
    session = await client.createSession();
    await fixture.restart();
    await Promise.allSettled([session.close(), client.disconnect()]);

    await client.connect(fixture.endpointUrl);
    reconnectedSession = await client.createSession();
    const result = await reconnectedSession.read([
      { nodeId: fixture.nodeIds.values.good, attributeId: 13 },
    ]);
    expect(statusName(result[0])).toBe('Good');
  } finally {
    await Promise.allSettled([
      ...(session === undefined ? [] : [session.close()]),
      ...(reconnectedSession === undefined ? [] : [reconnectedSession.close()]),
      client.disconnect(),
    ]);
  }
}

function expectEndpointPortReleased(endpointUrl: string): Promise<void> {
  const port = Number(new URL(endpointUrl).port);
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });
}

function browseForward(
  session: OpcUaSessionLike,
  nodeId: string,
  referenceTypeId: string,
): Promise<BrowseResultLike> {
  return session.browse({
    nodeId,
    browseDirection: BrowseDirection.Forward,
    referenceTypeId,
    includeSubtypes: true,
    resultMask: 63,
  });
}

async function expectGoodValues(session: OpcUaSessionLike, nodeIds: string[]): Promise<void> {
  for (
    let index = 0;
    index < nodeIds.length;
    index += OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS.maxNodesPerRead
  ) {
    const batch = nodeIds.slice(
      index,
      index + OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS.maxNodesPerRead,
    );
    const values = await session.read(batch.map((nodeId) => ({ nodeId, attributeId: 13 })));
    expect(values.map(statusName)).toEqual(Array.from({ length: batch.length }, () => 'Good'));
  }
}

function firstBrowseResult(result: BrowseResultLike | BrowseResultLike[]): BrowseResultLike {
  if (Array.isArray(result)) {
    const first = result[0];
    if (first === undefined) throw new Error('Expected a BrowseNext result.');
    return first;
  }
  return result;
}

function nodeIds(result: BrowseResultLike): string[] {
  return (result.references ?? []).map((reference) => reference.nodeId.toString());
}

function propertyNames(result: BrowseResultLike): string[] {
  return (result.references ?? []).flatMap((reference) =>
    reference.browseName?.name === undefined ? [] : [reference.browseName.name],
  );
}

function requireContinuation(result: BrowseResultLike): Uint8Array {
  if (result.continuationPoint === undefined)
    throw new Error('Expected a native continuation point.');
  return result.continuationPoint;
}

function statusName(value: DataValueLike | undefined): string | undefined {
  const statusCode = value?.statusCode;
  if (statusCode === undefined) return undefined;
  if (statusCode.name !== undefined) return statusCode.name;
  return statusCode.toString().split(' ')[0];
}
