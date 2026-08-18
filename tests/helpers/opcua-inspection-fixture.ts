import { createRequire } from 'node:module';

interface FixtureVariant {
  readonly arrayType: number;
}

interface OpcUaServerLike {
  readonly engine: { addressSpace: unknown; isStarted(): boolean };
  getEndpointUrl(): string;
  initialize(): Promise<void>;
  start(): Promise<void>;
  shutdown(timeout: number): Promise<void>;
  dispose(): void;
}

interface NodeOpcUaModule {
  OPCUAServer: new (options: Record<string, unknown>) => OpcUaServerLike;
  Argument: new (options: Record<string, unknown>) => unknown;
  DataType: {
    Null: number;
    Boolean: number;
    Int32: number;
    Int64: number;
    UInt64: number;
    Double: number;
    Float: number;
    String: number;
    DateTime: number;
    Guid: number;
    ByteString: number;
    NodeId: number;
    ExpandedNodeId: number;
    QualifiedName: number;
    LocalizedText: number;
    ExtensionObject: number;
  };
  DataValue: new (options: Record<string, unknown>) => unknown;
  EnumValueType: new (options: Record<string, unknown>) => unknown;
  ExpandedNodeId: { fromNodeId(nodeId: unknown, namespaceUri?: string): unknown };
  LocalizedText: new (options?: Record<string, unknown> | string | null) => unknown;
  MessageSecurityMode: { None: unknown };
  QualifiedName: new (options: Record<string, unknown>) => unknown;
  Range: new (options: Record<string, unknown>) => unknown;
  SecurityPolicy: { None: unknown };
  StatusCodes: {
    Good: unknown;
    UncertainLastUsableValue: unknown;
    BadNoDataAvailable: unknown;
    BadUserAccessDenied: unknown;
    BadInternalError: unknown;
  };
  Variant: new (options: Record<string, unknown>) => FixtureVariant;
  VariantArrayType: { Scalar: number; Array: number; Matrix: number };
  makeEUInformation(symbol: string, shortName: string, longName: string): unknown;
  makeNodeId(value: string, namespace?: number): unknown;
  setNamespaceMetaData(namespace: never): void;
  standardUnits: { degree_celsius: unknown };
}

const require = createRequire(import.meta.url);
const nodeOpcUa = require('node-opcua') as NodeOpcUaModule;
const {
  Argument,
  DataType,
  DataValue,
  EnumValueType,
  ExpandedNodeId,
  LocalizedText,
  MessageSecurityMode,
  OPCUAServer,
  QualifiedName,
  Range,
  SecurityPolicy,
  StatusCodes,
  Variant,
  VariantArrayType,
  standardUnits,
} = nodeOpcUa;
const makeEUInformation = (symbol: string, shortName: string, longName: string): unknown =>
  nodeOpcUa.makeEUInformation(symbol, shortName, longName);
const makeNodeId = (value: string, namespace?: number): unknown =>
  nodeOpcUa.makeNodeId(value, namespace);
const setNamespaceMetaData = (namespace: never): void => nodeOpcUa.setNamespaceMetaData(namespace);
interface FixtureNode {
  readonly nodeId: { toString(): string };
  addReference: (reference: {
    referenceType: string | FixtureNode;
    nodeId: string | FixtureNode;
  }) => void;
}

interface FixtureNamespace {
  index: number;
  namespaceUri: string;
  version: string;
  publicationDate: Date;
  addObject: (options: Record<string, unknown>) => FixtureNode;
  addVariable: (options: Record<string, unknown>) => FixtureNode;
  addReferenceType: (options: Record<string, unknown>) => FixtureNode;
}

interface FixtureAddressSpace {
  rootFolder: { objects: FixtureNode };
  registerNamespace: (namespaceUri: string) => FixtureNamespace;
}

export const OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS = {
  hierarchy: 'urn:managed-opcua-mcp:fixture:hierarchy',
  sparse: 'urn:managed-opcua-mcp:fixture:sparse',
} as const;

export const OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS = {
  maxNodesPerRead: 2,
  maxNodesPerBrowse: 1,
} as const;

export type FixtureReadOutcome = 'good' | 'uncertain' | 'bad' | 'denied' | 'failed';

export interface FixtureNodeIds {
  hierarchy: {
    root: string;
    area: string;
    machine: string;
    repeatedSource: string;
    repeatedTarget: string;
    cycleStart: string;
    cycleEnd: string;
    continuationSource: string;
  };
  sparse: {
    root: string;
    source: string;
    target: string;
    detached: string;
  };
  values: {
    good: string;
    uncertain: string;
    bad: string;
    denied: string;
    failed: string;
    boolean: string;
    safeInteger: string;
    float: string;
    nan: string;
    positiveInfinity: string;
    negativeInfinity: string;
    string: string;
    int64: string;
    uint64: string;
    byteString: string;
    dateTime: string;
    guid: string;
    nodeId: string;
    expandedNodeId: string;
    qualifiedName: string;
    localizedText: string;
    null: string;
    doubleArray: string;
    stringArray: string;
    matrix: string;
    extensionObject: string;
  };
  diagnostics: {
    valid: string;
    missing: string;
    ambiguous: string;
    oversized: string;
    unsupported: string;
    denied: string;
    properties: {
      validEngineeringUnits: string;
      validEuRange: string;
      validInstrumentRange: string;
      validEnumStrings: string;
      validEnumValues: string;
      ambiguousEuRangeOne: string;
      ambiguousEuRangeTwo: string;
      oversizedEnumStrings: string;
      unsupportedEngineeringUnits: string;
      deniedEngineeringUnits: string;
    };
  };
}

export interface FixtureReference {
  source: string;
  target: string;
  referenceType: string;
  direction: 'forward';
}

export interface OpcUaInspectionFixture {
  readonly endpointUrl: string;
  readonly nodeIds: FixtureNodeIds;
  readonly namespaceUris: typeof OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS;
  readonly namespaceIndexes: { hierarchy: number; sparse: number };
  readonly operationLimits: typeof OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS;
  readonly references: {
    hierarchy: readonly FixtureReference[];
    sparse: readonly FixtureReference[];
    evidenceLink: string;
  };
  readonly running: boolean;
  setReadOutcome(nodeId: string, outcome: FixtureReadOutcome): void;
  restart(): Promise<void>;
  close(): Promise<void>;
}

interface DynamicValue {
  readonly variant: FixtureVariant;
  outcome: FixtureReadOutcome;
}

interface StartedServer {
  server: OpcUaServerLike;
  endpointUrl: string;
  nodeIds: FixtureNodeIds;
  namespaceIndexes: { hierarchy: number; sparse: number };
  references: OpcUaInspectionFixture['references'];
  values: Map<string, DynamicValue>;
}

const SOURCE_TIMESTAMP = new Date('2026-08-01T12:00:00.000Z');
const SERVER_TIMESTAMP = new Date('2026-08-01T12:00:01.000Z');
const MAX_DIAGNOSTIC_ARRAY_LENGTH = 1_001;

/**
 * Starts a real, anonymous-only OPC UA Server for inspection tests. It exposes
 * read-only fixture data exclusively; it never creates a Semantic Control or
 * performs a Control Operation.
 */
export async function startOpcUaInspectionFixture(): Promise<OpcUaInspectionFixture> {
  const fixture = new InProcessOpcUaInspectionFixture();
  await fixture.start();
  return fixture;
}

class InProcessOpcUaInspectionFixture implements OpcUaInspectionFixture {
  private started: StartedServer | undefined;
  private stopped = false;

  get endpointUrl(): string {
    return this.requireStarted().endpointUrl;
  }

  get nodeIds(): FixtureNodeIds {
    return this.requireStarted().nodeIds;
  }

  get namespaceUris(): typeof OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS {
    return OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS;
  }

  get namespaceIndexes(): { hierarchy: number; sparse: number } {
    return this.requireStarted().namespaceIndexes;
  }

  get operationLimits(): typeof OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS {
    return OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS;
  }

  get references(): OpcUaInspectionFixture['references'] {
    return this.requireStarted().references;
  }

  get running(): boolean {
    return this.started !== undefined && !this.stopped;
  }

  async start(): Promise<void> {
    this.started = await startServer(0);
  }

  setReadOutcome(nodeId: string, outcome: FixtureReadOutcome): void {
    const value = this.requireStarted().values.get(nodeId);
    if (value === undefined) throw new Error(`Unknown fixture value NodeId: ${nodeId}`);
    value.outcome = outcome;
  }

  async restart(): Promise<void> {
    const current = this.requireStarted();
    const port = new URL(current.endpointUrl).port;
    await shutdownServer(current.server);
    this.started = await startServer(Number(port));
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const current = this.started;
    this.started = undefined;
    if (current !== undefined) await shutdownServer(current.server);
  }

  private requireStarted(): StartedServer {
    if (this.started === undefined || this.stopped) {
      throw new Error('The OPC UA inspection fixture is not running.');
    }
    return this.started;
  }
}

async function startServer(port: number): Promise<StartedServer> {
  const server = new OPCUAServer({
    port,
    hostname: '127.0.0.1',
    allowAnonymous: true,
    securityModes: [MessageSecurityMode.None],
    securityPolicies: [SecurityPolicy.None],
    serverCapabilities: {
      maxBrowseContinuationPoints: 10,
      operationLimits: OPCUA_INSPECTION_FIXTURE_OPERATION_LIMITS,
    },
  });

  try {
    await server.initialize();
    const addressSpace = server.engine.addressSpace as FixtureAddressSpace | null;
    if (addressSpace === null) throw new Error('The OPC UA fixture Server has no address space.');

    const hierarchy = addressSpace.registerNamespace(
      OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.hierarchy,
    );
    const sparse = addressSpace.registerNamespace(OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.sparse);
    configureNamespaceMetadata(hierarchy, '2026.08-hierarchy');
    configureNamespaceMetadata(sparse, '2026.08-sparse');

    const values = new Map<string, DynamicValue>();
    const nodeIds = buildFixtureAddressSpace(
      addressSpace.rootFolder.objects,
      hierarchy,
      sparse,
      values,
    );
    await server.start();

    return {
      server,
      endpointUrl: server.getEndpointUrl(),
      nodeIds,
      namespaceIndexes: { hierarchy: hierarchy.index, sparse: sparse.index },
      references: fixtureReferences(nodeIds, sparse.index),
      values,
    };
  } catch (error) {
    if (server.engine.isStarted()) await shutdownServer(server);
    else server.dispose();
    throw error;
  }
}

function configureNamespaceMetadata(namespace: FixtureNamespace, version: string): void {
  namespace.version = version;
  namespace.publicationDate = new Date('2026-08-01T00:00:00.000Z');
  setNamespaceMetaData(namespace as never);
}

function buildFixtureAddressSpace(
  objectsFolder: FixtureNode,
  hierarchy: FixtureNamespace,
  sparse: FixtureNamespace,
  values: Map<string, DynamicValue>,
): FixtureNodeIds {
  const hierarchyRoot = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.Root',
    browseName: 'HierarchyRoot',
    displayName: { locale: 'en-US', text: 'Hierarchy root' },
    organizedBy: objectsFolder,
    typeDefinition: 'FolderType',
  });
  const area = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.Area',
    browseName: 'Area',
    componentOf: hierarchyRoot,
  });
  const machine = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.Machine',
    browseName: 'Machine',
    description: { locale: 'en-US', text: 'Source-provided machine text.' },
    componentOf: area,
  });

  const repeatedSource = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.RepeatedSource',
    browseName: 'RepeatedSource',
    componentOf: hierarchyRoot,
  });
  const repeatedTarget = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.RepeatedTarget',
    browseName: 'RepeatedTarget',
    componentOf: repeatedSource,
  });
  repeatedSource.addReference({ referenceType: 'Organizes', nodeId: repeatedTarget });

  const cycleStart = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.CycleStart',
    browseName: 'CycleStart',
    componentOf: hierarchyRoot,
  });
  const cycleEnd = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.CycleEnd',
    browseName: 'CycleEnd',
    componentOf: cycleStart,
  });
  cycleEnd.addReference({ referenceType: 'HasComponent', nodeId: cycleStart });

  const continuationSource = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.ContinuationSource',
    browseName: 'ContinuationSource',
    componentOf: hierarchyRoot,
  });
  for (let index = 1; index <= 5; index += 1) {
    hierarchy.addObject({
      nodeId: `s=Fixture.Hierarchy.ContinuationTarget${String(index)}`,
      browseName: `ContinuationTarget${String(index)}`,
      componentOf: continuationSource,
    });
  }

  const valuesFolder = hierarchy.addObject({
    nodeId: 's=Fixture.Hierarchy.Values',
    browseName: 'Values',
    componentOf: machine,
  });
  const nodeIds = {
    good: addDynamicValue(hierarchy, valuesFolder, values, 'Good', DataType.Double, 21.5),
    uncertain: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'Uncertain',
      DataType.Double,
      20.5,
      'uncertain',
    ),
    bad: addDynamicValue(hierarchy, valuesFolder, values, 'Bad', DataType.Double, 0, 'bad'),
    denied: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'Denied',
      DataType.Double,
      0,
      'denied',
    ),
    failed: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'Failed',
      DataType.Double,
      0,
      'failed',
    ),
    boolean: addDynamicValue(hierarchy, valuesFolder, values, 'Boolean', DataType.Boolean, true),
    safeInteger: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'SafeInteger',
      DataType.Int32,
      42,
    ),
    float: addDynamicValue(hierarchy, valuesFolder, values, 'Float', DataType.Float, 12.5),
    nan: addDynamicValue(hierarchy, valuesFolder, values, 'NaN', DataType.Double, Number.NaN),
    positiveInfinity: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'PositiveInfinity',
      DataType.Double,
      Infinity,
    ),
    negativeInfinity: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'NegativeInfinity',
      DataType.Double,
      -Infinity,
    ),
    string: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'String',
      DataType.String,
      'fixture text',
    ),
    int64: addDynamicValue(hierarchy, valuesFolder, values, 'Int64', DataType.Int64, [0, 42]),
    uint64: addDynamicValue(hierarchy, valuesFolder, values, 'UInt64', DataType.UInt64, [0, 42]),
    byteString: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'ByteString',
      DataType.ByteString,
      Buffer.from([0, 1, 2, 255]),
    ),
    dateTime: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'DateTime',
      DataType.DateTime,
      SOURCE_TIMESTAMP,
    ),
    guid: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'Guid',
      DataType.Guid,
      '72962B91-FA75-4AE6-8D28-B404DC7DAF63',
    ),
    nodeId: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'NodeId',
      DataType.NodeId,
      makeNodeId('Fixture.Hierarchy.Machine', hierarchy.index),
    ),
    expandedNodeId: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'ExpandedNodeId',
      DataType.ExpandedNodeId,
      ExpandedNodeId.fromNodeId(
        makeNodeId('Fixture.Sparse.Target', sparse.index),
        OPCUA_INSPECTION_FIXTURE_NAMESPACE_URIS.sparse,
      ),
    ),
    qualifiedName: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'QualifiedName',
      DataType.QualifiedName,
      new QualifiedName({ namespaceIndex: hierarchy.index, name: 'FixtureName' }),
    ),
    localizedText: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'LocalizedText',
      DataType.LocalizedText,
      new LocalizedText({ locale: 'en-US', text: 'Fixture text' }),
    ),
    null: addDynamicValue(hierarchy, valuesFolder, values, 'Null', DataType.Null, null),
    doubleArray: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'DoubleArray',
      DataType.Double,
      [1.5, 2.5, 3.5],
      'good',
      VariantArrayType.Array,
    ),
    stringArray: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'StringArray',
      DataType.String,
      ['one', 'two'],
      'good',
      VariantArrayType.Array,
    ),
    matrix: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'Matrix',
      DataType.Double,
      [1, 2, 3, 4],
      'good',
      VariantArrayType.Matrix,
      [2, 2],
    ),
    extensionObject: addDynamicValue(
      hierarchy,
      valuesFolder,
      values,
      'ExtensionObject',
      DataType.ExtensionObject,
      new Argument({ name: 'Unsupported fixture ExtensionObject' }),
    ),
  };

  const diagnostics = buildDiagnosticFixtures(hierarchy, machine, values);

  const sparseRoot = sparse.addObject({
    nodeId: 's=Fixture.Sparse.Root',
    browseName: 'SparseRoot',
    organizedBy: objectsFolder,
    typeDefinition: 'FolderType',
  });
  const sparseSource = sparse.addObject({
    nodeId: 's=Fixture.Sparse.Source',
    browseName: 'SparseSource',
  });
  const sparseTarget = sparse.addObject({
    nodeId: 's=Fixture.Sparse.Target',
    browseName: 'SparseTarget',
  });
  const sparseDetached = sparse.addObject({
    nodeId: 's=Fixture.Sparse.Detached',
    browseName: 'SparseDetached',
  });
  const evidenceLink = sparse.addReferenceType({
    nodeId: 's=Fixture.ReferenceType.EvidenceLink',
    browseName: 'EvidenceLink',
    inverseName: 'EvidenceLinkFrom',
    subtypeOf: 'NonHierarchicalReferences',
  });
  sparseRoot.addReference({ referenceType: evidenceLink, nodeId: sparseSource });
  sparseSource.addReference({ referenceType: evidenceLink, nodeId: sparseTarget });
  sparseRoot.addReference({ referenceType: evidenceLink, nodeId: sparseDetached });

  return {
    hierarchy: {
      root: hierarchyRoot.nodeId.toString(),
      area: area.nodeId.toString(),
      machine: machine.nodeId.toString(),
      repeatedSource: repeatedSource.nodeId.toString(),
      repeatedTarget: repeatedTarget.nodeId.toString(),
      cycleStart: cycleStart.nodeId.toString(),
      cycleEnd: cycleEnd.nodeId.toString(),
      continuationSource: continuationSource.nodeId.toString(),
    },
    sparse: {
      root: sparseRoot.nodeId.toString(),
      source: sparseSource.nodeId.toString(),
      target: sparseTarget.nodeId.toString(),
      detached: sparseDetached.nodeId.toString(),
    },
    values: nodeIds,
    diagnostics,
  };
}

function buildDiagnosticFixtures(
  namespace: FixtureNamespace,
  parent: FixtureNode,
  values: Map<string, DynamicValue>,
): FixtureNodeIds['diagnostics'] {
  const valid = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticValid',
    DataType.Double,
    21.5,
  );
  const validEngineeringUnits = addDiagnosticProperty(
    namespace,
    valid,
    values,
    'ValidEngineeringUnits',
    'EngineeringUnits',
    'EUInformation',
    new Variant({ dataType: DataType.ExtensionObject, value: standardUnits.degree_celsius }),
  );
  const validEuRange = addDiagnosticProperty(
    namespace,
    valid,
    values,
    'ValidEURange',
    'EURange',
    'Range',
    new Variant({ dataType: DataType.ExtensionObject, value: new Range({ low: -40, high: 125 }) }),
  );
  const validInstrumentRange = addDiagnosticProperty(
    namespace,
    valid,
    values,
    'ValidInstrumentRange',
    'InstrumentRange',
    'Range',
    new Variant({ dataType: DataType.ExtensionObject, value: new Range({ low: -50, high: 150 }) }),
  );
  const validEnumStrings = addDiagnosticProperty(
    namespace,
    valid,
    values,
    'ValidEnumStrings',
    'EnumStrings',
    DataType.LocalizedText,
    new Variant({
      dataType: DataType.LocalizedText,
      arrayType: VariantArrayType.Array,
      value: [new LocalizedText('Stopped'), new LocalizedText('Running')],
    }),
  );
  const validEnumValues = addDiagnosticProperty(
    namespace,
    valid,
    values,
    'ValidEnumValues',
    'EnumValues',
    DataType.ExtensionObject,
    new Variant({
      dataType: DataType.ExtensionObject,
      arrayType: VariantArrayType.Array,
      value: [
        new EnumValueType({
          value: [0, 0],
          displayName: { locale: 'en-US', text: 'Stopped' },
          description: { locale: 'en-US', text: 'Fixture stopped state.' },
        }),
        new EnumValueType({
          value: [0, 1],
          displayName: { locale: 'en-US', text: 'Running' },
          description: { locale: 'en-US', text: 'Fixture running state.' },
        }),
      ],
    }),
  );

  const missing = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticMissing',
    DataType.Double,
    22.5,
  );

  const ambiguous = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticAmbiguous',
    DataType.Double,
    23.5,
  );
  const ambiguousEuRangeOne = addDiagnosticProperty(
    namespace,
    ambiguous,
    values,
    'AmbiguousEURangeOne',
    'EURange',
    'Range',
    new Variant({ dataType: DataType.ExtensionObject, value: new Range({ low: 0, high: 10 }) }),
  );
  const ambiguousEuRangeTwo = addDiagnosticProperty(
    namespace,
    ambiguous,
    values,
    'AmbiguousEURangeTwo',
    'EURange',
    'Range',
    new Variant({ dataType: DataType.ExtensionObject, value: new Range({ low: 10, high: 20 }) }),
  );

  const oversized = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticOversized',
    DataType.Double,
    24.5,
  );
  const oversizedEnumStrings = addDiagnosticProperty(
    namespace,
    oversized,
    values,
    'OversizedEnumStrings',
    'EnumStrings',
    DataType.LocalizedText,
    new Variant({
      dataType: DataType.LocalizedText,
      arrayType: VariantArrayType.Array,
      value: Array.from(
        { length: MAX_DIAGNOSTIC_ARRAY_LENGTH },
        (_, index) => new LocalizedText({ locale: 'en-US', text: `State ${String(index)}` }),
      ),
    }),
  );

  const unsupported = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticUnsupported',
    DataType.Double,
    25.5,
  );
  const unsupportedEngineeringUnits = addDiagnosticProperty(
    namespace,
    unsupported,
    values,
    'UnsupportedEngineeringUnits',
    'EngineeringUnits',
    DataType.ExtensionObject,
    new Variant({
      dataType: DataType.ExtensionObject,
      value: new Argument({ name: 'Unsupported fixture ExtensionObject' }),
    }),
  );

  const denied = addDynamicValue(
    namespace,
    parent,
    values,
    'DiagnosticDenied',
    DataType.Double,
    26.5,
  );
  const deniedEngineeringUnits = addDiagnosticProperty(
    namespace,
    denied,
    values,
    'DeniedEngineeringUnits',
    'EngineeringUnits',
    'EUInformation',
    new Variant({
      dataType: DataType.ExtensionObject,
      value: makeEUInformation('CEL', '°C', 'degrees Celsius'),
    }),
    'denied',
  );

  return {
    valid,
    missing,
    ambiguous,
    oversized,
    unsupported,
    denied,
    properties: {
      validEngineeringUnits,
      validEuRange,
      validInstrumentRange,
      validEnumStrings,
      validEnumValues,
      ambiguousEuRangeOne,
      ambiguousEuRangeTwo,
      oversizedEnumStrings,
      unsupportedEngineeringUnits,
      deniedEngineeringUnits,
    },
  };
}

function addDynamicValue(
  namespace: FixtureNamespace,
  parent: FixtureNode,
  values: Map<string, DynamicValue>,
  name: string,
  dataType: number,
  value: unknown,
  outcome: FixtureReadOutcome = 'good',
  arrayType: number = VariantArrayType.Scalar,
  dimensions?: number[],
): string {
  const variant = new Variant({
    dataType,
    arrayType,
    value,
    ...(dimensions === undefined ? {} : { dimensions }),
  });
  const nodeId = `s=Fixture.Value.${name}`;
  const dynamic: DynamicValue = { variant, outcome };
  return addBoundValueNode(namespace, values, dynamic, {
    nodeId,
    browseName: name,
    componentOf: parent,
    dataType,
    valueRank:
      arrayType === VariantArrayType.Scalar ? -1 : arrayType === VariantArrayType.Array ? 1 : 2,
    ...(dimensions === undefined ? {} : { arrayDimensions: dimensions }),
    accessLevel: 'CurrentRead',
    userAccessLevel: 'CurrentRead',
    minimumSamplingInterval: 100,
  });
}

function addDiagnosticProperty(
  namespace: FixtureNamespace,
  parentNodeId: string,
  values: Map<string, DynamicValue>,
  identifier: string,
  browseName: string,
  dataType: number | string,
  variant: FixtureVariant,
  outcome: FixtureReadOutcome = 'good',
): string {
  const dynamic: DynamicValue = { variant, outcome };
  return addBoundValueNode(namespace, values, dynamic, {
    nodeId: `s=Fixture.Diagnostic.${identifier}`,
    browseName: { namespaceIndex: 0, name: browseName },
    propertyOf: parentNodeId,
    dataType,
    typeDefinition: 'PropertyType',
    valueRank: variant.arrayType === VariantArrayType.Scalar ? -1 : 1,
    accessLevel: 'CurrentRead',
    userAccessLevel: 'CurrentRead',
    minimumSamplingInterval: 100,
  });
}

function addBoundValueNode(
  namespace: FixtureNamespace,
  values: Map<string, DynamicValue>,
  dynamic: DynamicValue,
  options: Record<string, unknown>,
): string {
  const variable = namespace.addVariable({
    ...options,
    value: { timestamped_get: () => dataValueFor(dynamic) },
  });
  const canonicalNodeId = variable.nodeId.toString();
  values.set(canonicalNodeId, dynamic);
  return canonicalNodeId;
}

function dataValueFor(dynamic: DynamicValue): unknown {
  const statusCode = statusCodeFor(dynamic.outcome);
  return new DataValue({
    ...(dynamic.outcome === 'bad' || dynamic.outcome === 'denied' || dynamic.outcome === 'failed'
      ? {}
      : { value: dynamic.variant }),
    statusCode,
    sourceTimestamp: SOURCE_TIMESTAMP,
    serverTimestamp: SERVER_TIMESTAMP,
  });
}

function statusCodeFor(outcome: FixtureReadOutcome): unknown {
  switch (outcome) {
    case 'good':
      return StatusCodes.Good;
    case 'uncertain':
      return StatusCodes.UncertainLastUsableValue;
    case 'bad':
      return StatusCodes.BadNoDataAvailable;
    case 'denied':
      return StatusCodes.BadUserAccessDenied;
    case 'failed':
      return StatusCodes.BadInternalError;
  }
}

function fixtureReferences(
  nodeIds: FixtureNodeIds,
  sparseNamespaceIndex: number,
): OpcUaInspectionFixture['references'] {
  const component = 'ns=0;i=47';
  const organizes = 'ns=0;i=35';
  const evidenceLink = `ns=${String(sparseNamespaceIndex)};s=Fixture.ReferenceType.EvidenceLink`;
  return {
    hierarchy: [
      {
        source: nodeIds.hierarchy.root,
        target: nodeIds.hierarchy.area,
        referenceType: component,
        direction: 'forward',
      },
      {
        source: nodeIds.hierarchy.repeatedSource,
        target: nodeIds.hierarchy.repeatedTarget,
        referenceType: component,
        direction: 'forward',
      },
      {
        source: nodeIds.hierarchy.repeatedSource,
        target: nodeIds.hierarchy.repeatedTarget,
        referenceType: organizes,
        direction: 'forward',
      },
      {
        source: nodeIds.hierarchy.cycleStart,
        target: nodeIds.hierarchy.cycleEnd,
        referenceType: component,
        direction: 'forward',
      },
      {
        source: nodeIds.hierarchy.cycleEnd,
        target: nodeIds.hierarchy.cycleStart,
        referenceType: component,
        direction: 'forward',
      },
    ],
    sparse: [
      {
        source: nodeIds.sparse.root,
        target: nodeIds.sparse.source,
        referenceType: evidenceLink,
        direction: 'forward',
      },
      {
        source: nodeIds.sparse.root,
        target: nodeIds.sparse.detached,
        referenceType: evidenceLink,
        direction: 'forward',
      },
      {
        source: nodeIds.sparse.source,
        target: nodeIds.sparse.target,
        referenceType: evidenceLink,
        direction: 'forward',
      },
    ],
    evidenceLink,
  };
}

async function shutdownServer(server: OpcUaServerLike): Promise<void> {
  await server.shutdown(0);
}
