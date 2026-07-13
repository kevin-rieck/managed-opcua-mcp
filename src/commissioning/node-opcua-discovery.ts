import type {
  CommissioningCoverageSummary,
  CommissioningDiscoveryRequest,
  CommissioningDiscoveryResult,
  CommissioningFieldFailure,
  CommissioningMetadataField,
  CommissioningNode,
  CommissioningNodeClass,
  CommissioningRootCoverage,
  CommissioningSupportedControlDataType,
  Evidence,
  SanitizedOpcUaStatus,
} from './discovery.js';
import { generateDraftSemanticControlCandidates } from './draft-semantic-controls.js';
import type {
  OpcUaBrowseResponse,
  OpcUaDataValueLike,
  OpcUaReferenceLike,
  OpcUaSessionLike,
} from '../opcua/node-opcua-gateway.js';

const ATTRIBUTE_NODE_CLASS = 2;
const ATTRIBUTE_BROWSE_NAME = 3;
const ATTRIBUTE_DISPLAY_NAME = 4;
const ATTRIBUTE_DESCRIPTION = 5;
const ATTRIBUTE_DATA_TYPE = 14;
const ATTRIBUTE_VALUE_RANK = 15;
const ATTRIBUTE_ARRAY_DIMENSIONS = 16;
const ATTRIBUTE_ACCESS_LEVEL = 17;
const ATTRIBUTE_USER_ACCESS_LEVEL = 18;
const ATTRIBUTE_EXECUTABLE = 21;
const ATTRIBUTE_USER_EXECUTABLE = 22;
const ACCESS_LEVEL_CURRENT_READ = 0x01;
const ACCESS_LEVEL_CURRENT_WRITE = 0x02;
const DEFAULT_DISCOVERY_ROOT = 'ns=0;i=85';
const DEFAULT_DISCOVERY_DEPTH = 4;
const DEFAULT_DISCOVERY_NODES = 1_000;
const MAX_DISCOVERY_DEPTH = 10;
const MAX_DISCOVERY_NODES = 1_000;

interface QueueEntry {
  nodeId: string;
  depth: number;
  path: string[];
  reference?: OpcUaReferenceLike;
}

interface FieldRead {
  field: CommissioningMetadataField;
  attributeId: number;
  result: OpcUaDataValueLike | Error;
}

export async function discoverWithNodeOpcUa(
  session: OpcUaSessionLike,
  request: CommissioningDiscoveryRequest,
  now: () => Date,
): Promise<CommissioningDiscoveryResult> {
  if (session.browse === undefined || session.read === undefined)
    throw new Error('OPC UA session does not support commissioning discovery.');
  const maxDepth = request.maxDepth ?? DEFAULT_DISCOVERY_DEPTH;
  const maxNodes = request.maxNodes ?? DEFAULT_DISCOVERY_NODES;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_DISCOVERY_DEPTH)
    throw new Error(
      `Commissioning discovery maxDepth must be an integer from 0 to ${String(MAX_DISCOVERY_DEPTH)}.`,
    );
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_DISCOVERY_NODES)
    throw new Error(
      `Commissioning discovery maxNodes must be an integer from 1 to ${String(MAX_DISCOVERY_NODES)}.`,
    );

  const generatedAt = now().toISOString();
  const nodes = new Map<string, CommissioningNode>();
  const roots: CommissioningRootCoverage[] = [];
  const blocking: CommissioningDiscoveryResult['findings']['blocking'] = [];
  const warnings: CommissioningDiscoveryResult['findings']['warnings'] = [];
  const fieldCounts = new Map<
    CommissioningMetadataField,
    { succeeded: number; failed: number; notPresent: number }
  >();
  const suggestedReadEntryPoints: CommissioningDiscoveryResult['suggestedReadEntryPoints'] = [];
  let maximumDepthReached = 0;
  const usesStandardRoot = request.roots.length === 0;
  const requestedRoots = usesStandardRoot ? [DEFAULT_DISCOVERY_ROOT] : request.roots;

  for (const rootNodeId of [...new Set(requestedRoots)].sort()) {
    const rootLabel = labelFromNodeId(rootNodeId);
    const queue: QueueEntry[] = [{ nodeId: rootNodeId, depth: 0, path: [rootLabel] }];
    const seenForRoot = new Set<string>();
    let rootDepthReached = 0;
    let rootPartial = false;
    let rootBrowseFailed: SanitizedOpcUaStatus | undefined;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seenForRoot.has(current.nodeId)) continue;

      if (!nodes.has(current.nodeId) && nodes.size >= maxNodes) {
        rootPartial = true;
        addFinding(warnings, {
          code: 'max_nodes_reached',
          area: rootNodeId,
          message: `Discovery stopped at the configured ${String(maxNodes)}-Node cap.`,
        });
        break;
      }
      seenForRoot.add(current.nodeId);

      rootDepthReached = Math.max(rootDepthReached, current.depth);
      maximumDepthReached = Math.max(maximumDepthReached, current.depth);
      if (!nodes.has(current.nodeId)) {
        const node = await inspectNode(session, current, generatedAt, fieldCounts);
        nodes.set(current.nodeId, node);
        if ((node.partialFailures?.length ?? 0) > 0) {
          rootPartial = true;
          addFinding(warnings, {
            code: 'metadata_read_failed',
            area: current.nodeId,
            message: 'Some OPC UA metadata attributes could not be read.',
          });
        }
      }

      let browseResponse: OpcUaBrowseResponse;
      try {
        browseResponse = await browseAll(session, current.nodeId);
      } catch (error) {
        const status = statusFromError(error);
        rootPartial = true;
        if (current.depth === 0) rootBrowseFailed = status;
        addFinding(current.depth === 0 ? blocking : warnings, {
          code: 'root_browse_failed',
          area: current.nodeId,
          message: `Forward hierarchical browse failed with ${status.code}.`,
        });
        continue;
      }

      const browseStatus = sanitizeStatus(browseResponse.statusCode);
      if (browseStatus.severity === 'bad' || browseStatus.severity === 'unknown') {
        rootPartial = true;
        if (current.depth === 0) rootBrowseFailed = browseStatus;
        addFinding(current.depth === 0 ? blocking : warnings, {
          code: 'root_browse_failed',
          area: current.nodeId,
          message: `Forward hierarchical browse failed with ${browseStatus.code}.`,
        });
        continue;
      }

      const references = [...(browseResponse.references ?? [])]
        .map((reference) => ({ reference, nodeId: stringifyValue(reference.nodeId) }))
        .filter(
          (item): item is { reference: OpcUaReferenceLike; nodeId: string } =>
            item.nodeId !== undefined,
        )
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

      const currentNode = nodes.get(current.nodeId);
      if (currentNode !== undefined) {
        const propertyFailures = await readDataAccessProperties(
          session,
          currentNode,
          references,
          generatedAt,
          fieldCounts,
        );
        if (propertyFailures > 0) {
          rootPartial = true;
          addFinding(warnings, {
            code: 'metadata_read_failed',
            area: current.nodeId,
            message: 'Some OPC UA metadata attributes could not be read.',
          });
        }
      }

      if (current.depth >= maxDepth) {
        if (references.some(({ nodeId }) => !seenForRoot.has(nodeId))) {
          rootPartial = true;
          addFinding(warnings, {
            code: 'max_depth_reached',
            area: rootNodeId,
            message: `Discovery stopped at the configured depth of ${String(maxDepth)}.`,
          });
        }
        continue;
      }

      for (const { reference, nodeId } of references) {
        if (seenForRoot.has(nodeId)) continue;
        const label = referenceLabel(reference) ?? labelFromNodeId(nodeId);
        queue.push({ nodeId, depth: current.depth + 1, path: [...current.path, label], reference });
      }
    }

    const rootFailed = rootBrowseFailed !== undefined;
    roots.push({
      nodeId: rootNodeId,
      status: rootFailed ? 'failed' : rootPartial ? 'partial' : 'succeeded',
      nodesVisited: seenForRoot.size,
      depthReached: rootDepthReached,
      ...(rootBrowseFailed === undefined ? {} : { statusDetail: rootBrowseFailed }),
    });
    if (!rootFailed) {
      suggestedReadEntryPoints.push({
        nodeId: rootNodeId,
        suggestedLabel: toSnakeCase(rootLabel),
        reason: usesStandardRoot ? 'high_level_object' : 'requested_root',
        evidence: [evidence('browse_succeeded', 'browse', generatedAt)],
      });
    }
  }

  const orderedNodes = [...nodes.values()].sort((left, right) =>
    left.identity.nodeId.localeCompare(right.identity.nodeId),
  );
  const orderedRoots = roots.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const coverage: CommissioningCoverageSummary = {
    requestedRoots: orderedRoots.length,
    succeededRoots: orderedRoots.filter((root) => root.status === 'succeeded').length,
    failedRoots: orderedRoots.filter((root) => root.status === 'failed').length,
    nodesVisited: orderedNodes.length,
    maxNodes,
    depthRequested: maxDepth,
    depthReached: maximumDepthReached,
    fields: Object.fromEntries(
      [...fieldCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };

  return generateDraftSemanticControlCandidates({
    generatedAt,
    roots: orderedRoots,
    nodes: orderedNodes,
    suggestedReadEntryPoints: suggestedReadEntryPoints.sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    draftSemanticControls: [],
    writableButNotSuggested: [],
    findings: { blocking: sortFindings(blocking), warnings: sortFindings(warnings) },
    coverage,
  });
}

async function inspectNode(
  session: OpcUaSessionLike,
  entry: QueueEntry,
  observedAt: string,
  counts: Map<
    CommissioningMetadataField,
    { succeeded: number; failed: number; notPresent: number }
  >,
): Promise<CommissioningNode> {
  const nodeClassRead = await readField(session, entry.nodeId, 'NodeClass', ATTRIBUTE_NODE_CLASS);
  const readNodeClass = valueOf(nodeClassRead.result);
  const nodeClass = mapNodeClass(readNodeClass ?? entry.reference?.nodeClass);
  const fields: [CommissioningMetadataField, number][] = [
    ['BrowseName', ATTRIBUTE_BROWSE_NAME],
    ['DisplayName', ATTRIBUTE_DISPLAY_NAME],
    ['Description', ATTRIBUTE_DESCRIPTION],
  ];
  if (nodeClass === 'Variable' || nodeClass === 'VariableType') {
    fields.push(
      ['DataType', ATTRIBUTE_DATA_TYPE],
      ['ValueRank', ATTRIBUTE_VALUE_RANK],
      ['ArrayDimensions', ATTRIBUTE_ARRAY_DIMENSIONS],
      ['AccessLevel', ATTRIBUTE_ACCESS_LEVEL],
      ['UserAccessLevel', ATTRIBUTE_USER_ACCESS_LEVEL],
    );
  }
  if (nodeClass === 'Method')
    fields.push(
      ['Executable', ATTRIBUTE_EXECUTABLE],
      ['UserExecutable', ATTRIBUTE_USER_EXECUTABLE],
    );

  const reads = [
    nodeClassRead,
    ...(await Promise.all(
      fields.map(([field, id]) => readField(session, entry.nodeId, field, id)),
    )),
  ];
  const failures: CommissioningFieldFailure[] = [];
  for (const read of reads) countRead(read, counts, failures);
  const byField = new Map(reads.map((read) => [read.field, read]));
  const browseName =
    stringifyValue(valueOf(byField.get('BrowseName')?.result)) ??
    stringifyValue(entry.reference?.browseName);
  const displayName =
    stringifyDisplayName(valueOf(byField.get('DisplayName')?.result)) ??
    stringifyDisplayName(entry.reference?.displayName);
  const description = stringifyDisplayName(valueOf(byField.get('Description')?.result));
  const typeDefinition = stringifyValue(entry.reference?.typeDefinition);
  const readDataType = valueOf(byField.get('DataType')?.result);
  const dataType = stringifyDataType(readDataType ?? entry.reference?.dataType);
  const valueRank = numberValue(valueOf(byField.get('ValueRank')?.result));
  const arrayDimensions = numberArray(valueOf(byField.get('ArrayDimensions')?.result));
  const accessLevel = numberValue(valueOf(byField.get('AccessLevel')?.result));
  const userAccessLevel = numberValue(valueOf(byField.get('UserAccessLevel')?.result));
  const executable = booleanValue(valueOf(byField.get('Executable')?.result));
  const userExecutable = booleanValue(valueOf(byField.get('UserExecutable')?.result));
  const node: CommissioningNode = {
    identity: {
      nodeId: entry.nodeId,
      ...(browseName === undefined ? {} : { browseName }),
      ...(displayName === undefined ? {} : { displayName }),
      path: entry.path,
      ...(typeDefinition === undefined ? {} : { typeDefinition }),
    },
    ...(nodeClass === undefined
      ? {}
      : {
          nodeClass: evidence(
            nodeClass,
            readNodeClass === undefined ? 'browse' : 'metadata_read',
            observedAt,
          ),
        }),
    ...(description === undefined
      ? {}
      : { description: evidence(description, 'metadata_read', observedAt) }),
  };
  if (valueRank !== undefined) {
    const kind =
      valueRank === -1
        ? 'scalar'
        : valueRank === 0 || valueRank === 1
          ? 'array'
          : valueRank >= 2
            ? 'matrix'
            : 'unknown';
    node.valueShape = {
      kind,
      valueRank,
      ...(arrayDimensions === undefined ? {} : { arrayDimensions }),
      evidence: evidence(kind, 'metadata_read', observedAt),
    };
  }
  if (dataType !== undefined) {
    const mappedType = mapSupportedDataType(dataType);
    node.dataType = {
      opcuaName: dataType,
      ...(mappedType === undefined ? {} : { mappedType }),
      evidence: evidence(
        dataType,
        readDataType === undefined ? 'browse' : 'metadata_read',
        observedAt,
      ),
    };
  }
  if (
    accessLevel !== undefined ||
    userAccessLevel !== undefined ||
    executable !== undefined ||
    userExecutable !== undefined
  ) {
    node.access = {
      ...(accessLevel === undefined
        ? {}
        : { access: evidence(decodeAccess(accessLevel), 'metadata_read', observedAt) }),
      ...(userAccessLevel === undefined
        ? {}
        : { userAccess: evidence(decodeAccess(userAccessLevel), 'metadata_read', observedAt) }),
      ...(userAccessLevel === undefined
        ? {}
        : {
            readable: evidence(
              (userAccessLevel & ACCESS_LEVEL_CURRENT_READ) !== 0,
              'metadata_read',
              observedAt,
            ),
            writable: evidence(
              (userAccessLevel & ACCESS_LEVEL_CURRENT_WRITE) !== 0,
              'metadata_read',
              observedAt,
            ),
          }),
      ...(executable === undefined
        ? {}
        : { executable: evidence(executable, 'metadata_read', observedAt) }),
      ...(userExecutable === undefined
        ? {}
        : {
            userExecutable: evidence(userExecutable, 'metadata_read', observedAt),
            callable: evidence(userExecutable, 'metadata_read', observedAt),
          }),
    };
  }
  if (failures.length > 0)
    node.partialFailures = failures.sort((left, right) => left.field.localeCompare(right.field));
  return node;
}

async function readDataAccessProperties(
  session: OpcUaSessionLike,
  node: CommissioningNode,
  references: { reference: OpcUaReferenceLike; nodeId: string }[],
  observedAt: string,
  counts: Map<
    CommissioningMetadataField,
    { succeeded: number; failed: number; notPresent: number }
  >,
): Promise<number> {
  if (node.nodeClass?.value !== 'Variable' || node.dataAccess !== undefined) return 0;
  const propertyFields = new Map<string, CommissioningMetadataField>([
    ['EngineeringUnits', 'EngineeringUnits'],
    ['EURange', 'EURange'],
    ['InstrumentRange', 'InstrumentRange'],
    ['EnumStrings', 'EnumStrings'],
    ['EnumValues', 'EnumValues'],
  ]);
  const properties = references
    .map(({ reference, nodeId }) => ({
      nodeId,
      field: propertyFields.get(stripNamespace(stringifyValue(reference.browseName)) ?? ''),
    }))
    .filter(
      (property): property is { nodeId: string; field: CommissioningMetadataField } =>
        property.field !== undefined,
    );
  if (properties.length === 0) return 0;

  const reads = await Promise.all(
    properties.map(({ nodeId, field }) => readField(session, nodeId, field, 13)),
  );
  const failures: CommissioningFieldFailure[] = [];
  for (const read of reads) countRead(read, counts, failures);
  const dataAccess: NonNullable<CommissioningNode['dataAccess']> = {};
  for (const read of reads) {
    if (read.result instanceof Error || sanitizeStatus(read.result.statusCode).severity !== 'good')
      continue;
    const value = read.result.value?.value;
    if (read.field === 'EngineeringUnits') {
      const engineeringUnits = mapEngineeringUnits(value);
      if (engineeringUnits !== undefined)
        dataAccess.engineeringUnits = evidence(
          engineeringUnits,
          'data_access_property',
          observedAt,
        );
    } else if (read.field === 'EURange' || read.field === 'InstrumentRange') {
      const range = mapRange(value);
      if (range !== undefined) {
        const rangeEvidence = evidence(range, 'data_access_property', observedAt);
        if (read.field === 'EURange') dataAccess.euRange = rangeEvidence;
        else dataAccess.instrumentRange = rangeEvidence;
      }
    } else if (read.field === 'EnumStrings') {
      const enumStrings = mapEnumStrings(value);
      if (enumStrings !== undefined)
        dataAccess.enumStrings = evidence(enumStrings, 'data_access_property', observedAt);
    } else if (read.field === 'EnumValues') {
      const enumValues = mapEnumValues(value);
      if (enumValues !== undefined)
        dataAccess.enumValues = evidence(enumValues, 'data_access_property', observedAt);
    }
  }
  if (Object.keys(dataAccess).length > 0) node.dataAccess = dataAccess;
  if (failures.length > 0) {
    node.partialFailures = [...(node.partialFailures ?? []), ...failures].sort((left, right) =>
      left.field.localeCompare(right.field),
    );
  }
  return failures.length;
}

async function readField(
  session: OpcUaSessionLike,
  nodeId: string,
  field: CommissioningMetadataField,
  attributeId: number,
): Promise<FieldRead> {
  try {
    if (session.read === undefined)
      throw new Error('OPC UA session does not support metadata reads.');
    return { field, attributeId, result: await session.read({ nodeId, attributeId }) };
  } catch (error) {
    return {
      field,
      attributeId,
      result: error instanceof Error ? error : new Error('Metadata read failed.'),
    };
  }
}

function countRead(
  read: FieldRead,
  counts: Map<
    CommissioningMetadataField,
    { succeeded: number; failed: number; notPresent: number }
  >,
  failures: CommissioningFieldFailure[],
): void {
  const count = counts.get(read.field) ?? { succeeded: 0, failed: 0, notPresent: 0 };
  if (read.result instanceof Error) {
    count.failed += 1;
    failures.push({ field: read.field, status: statusFromError(read.result) });
  } else {
    const status = sanitizeStatus(read.result.statusCode);
    if (status.severity === 'good') {
      const fieldValue = read.result.value?.value;
      if (fieldValue === undefined || fieldValue === null) count.notPresent += 1;
      else count.succeeded += 1;
    } else {
      count.failed += 1;
      failures.push({ field: read.field, status });
    }
  }
  counts.set(read.field, count);
}

function valueOf(result: OpcUaDataValueLike | Error | undefined): unknown {
  return result instanceof Error ? undefined : result?.value?.value;
}

async function browseAll(session: OpcUaSessionLike, nodeId: string): Promise<OpcUaBrowseResponse> {
  if (session.browse === undefined) throw new Error('OPC UA session does not support browsing.');
  let response = await session.browse(browseDescription(nodeId));
  const references = [...(response.references ?? [])];
  const initialStatus = sanitizeStatus(response.statusCode);
  if (initialStatus.severity === 'bad' || initialStatus.severity === 'unknown')
    return { references, statusCode: response.statusCode };
  let continuationPoint = response.continuationPoint;
  let pages = 1;
  while (hasContinuationPoint(continuationPoint)) {
    if (session.browseNext === undefined)
      throw new Error('OPC UA browse continuation is not supported by this session.');
    if (pages >= 10_000) throw new Error('OPC UA browse continuation exceeded the safety cap.');
    response = await session.browseNext(continuationPoint, false);
    references.push(...(response.references ?? []));
    const status = sanitizeStatus(response.statusCode);
    if (status.severity === 'bad' || status.severity === 'unknown')
      return { references, statusCode: response.statusCode };
    continuationPoint = response.continuationPoint;
    pages += 1;
  }
  return { references, statusCode: response.statusCode ?? { name: 'Good' } };
}

function hasContinuationPoint(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (value instanceof Uint8Array) return value.length > 0;
  return true;
}

function browseDescription(nodeId: string) {
  return {
    nodeId,
    browseDirection: 'Forward' as const,
    referenceTypeId: 'HierarchicalReferences' as const,
    includeSubtypes: true as const,
    resultMask: 63,
  };
}

function evidence<T>(value: T, source: Evidence<T>['source'], observedAt: string): Evidence<T> {
  return { value, source, status: { severity: 'good', code: 'Good' }, observedAt };
}

function sanitizeStatus(value: unknown): SanitizedOpcUaStatus {
  const code = statusCode(value) ?? 'Unknown';
  const severity = code.startsWith('Good')
    ? 'good'
    : code.startsWith('Uncertain')
      ? 'uncertain'
      : code.startsWith('Bad')
        ? 'bad'
        : 'unknown';
  return { severity, code };
}

function statusFromError(error: unknown): SanitizedOpcUaStatus {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'opcua_metadata_failed';
  const status: SanitizedOpcUaStatus = { severity: 'bad', code };
  const message = error instanceof Error ? error.message.split('\n')[0]?.slice(0, 500) : undefined;
  if (message !== undefined) status.message = message;
  return status;
}

function statusCode(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string'
  )
    return value.name;
  return stringifyValue(value);
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function' &&
    value.toString !== Object.prototype.toString
  ) {
    // OPC UA SDK identifier objects stringify to canonical NodeId/QualifiedName text.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return value.toString();
  }
  return undefined;
}

function stringifyDisplayName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string'
  )
    return value.text;
  return stringifyValue(value);
}

function stringifyDataType(value: unknown): string | undefined {
  const builtins: Record<number, string> = {
    1: 'Boolean',
    2: 'SByte',
    3: 'Byte',
    4: 'Int16',
    5: 'UInt16',
    6: 'Int32',
    7: 'UInt32',
    10: 'Float',
    11: 'Double',
    12: 'String',
  };
  if (typeof value === 'number') return builtins[value] ?? String(value);
  const text = stringifyValue(value);
  const builtInNodeId = text?.match(/^(?:ns=0;)?i=(\d+)$/)?.[1];
  if (builtInNodeId === undefined) return text;
  const identifier = Number(builtInNodeId);
  return builtins[identifier] ?? text;
}

function mapNodeClass(value: unknown): CommissioningNodeClass | undefined {
  const classes: Record<number, CommissioningNodeClass> = {
    1: 'Object',
    2: 'Variable',
    4: 'Method',
    8: 'ObjectType',
    16: 'VariableType',
    32: 'ReferenceType',
    64: 'DataType',
    128: 'View',
  };
  if (typeof value === 'number') return classes[value];
  const text = stringifyValue(value);
  return text !== undefined && Object.values(classes).includes(text as CommissioningNodeClass)
    ? (text as CommissioningNodeClass)
    : undefined;
}

function mapEngineeringUnits(value: unknown) {
  if (!isRecord(value)) return undefined;
  const displayName = stringifyDisplayName(value['displayName']);
  const description = stringifyDisplayName(value['description']);
  const unitId = numberValue(value['unitId']);
  const namespaceUri = stringifyValue(value['namespaceUri']);
  if (
    displayName === undefined &&
    description === undefined &&
    unitId === undefined &&
    namespaceUri === undefined
  )
    return undefined;
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(unitId === undefined ? {} : { unitId }),
    ...(namespaceUri === undefined ? {} : { namespaceUri }),
  };
}

function mapRange(value: unknown) {
  if (!isRecord(value)) return undefined;
  const low = numberValue(value['low']);
  const high = numberValue(value['high']);
  return low === undefined || high === undefined ? undefined : { low, high };
}

function mapEnumStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.map(stringifyDisplayName);
  return labels.every((label): label is string => label !== undefined) ? labels : undefined;
}

function mapEnumValues(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => {
    if (!isRecord(item)) return undefined;
    const enumValue = item['value'];
    if (typeof enumValue !== 'number' && typeof enumValue !== 'string') return undefined;
    const displayName = stringifyDisplayName(item['displayName']);
    const description = stringifyDisplayName(item['description']);
    return {
      value: enumValue,
      ...(displayName === undefined ? {} : { displayName }),
      ...(description === undefined ? {} : { description }),
    };
  });
  return values.every((item): item is NonNullable<typeof item> => item !== undefined)
    ? values
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapSupportedDataType(value: string): CommissioningSupportedControlDataType | undefined {
  const supported = [
    'Boolean',
    'SByte',
    'Byte',
    'Int16',
    'UInt16',
    'Int32',
    'UInt32',
    'Float',
    'Double',
    'String',
  ] as const;
  return supported.find((item) => item === value);
}

function decodeAccess(value: number) {
  return {
    currentRead: (value & ACCESS_LEVEL_CURRENT_READ) !== 0,
    currentWrite: (value & ACCESS_LEVEL_CURRENT_WRITE) !== 0,
    historyRead: (value & 0x04) !== 0,
    historyWrite: (value & 0x08) !== 0,
    semanticChange: (value & 0x10) !== 0,
    statusWrite: (value & 0x20) !== 0,
    timestampWrite: (value & 0x40) !== 0,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function numberArray(value: unknown): number[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value;
  if (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  )
    return Array.from(value);
  return undefined;
}
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function referenceLabel(reference: OpcUaReferenceLike): string | undefined {
  return (
    stripNamespace(stringifyValue(reference.browseName)) ??
    stringifyDisplayName(reference.displayName)
  );
}
function labelFromNodeId(nodeId: string): string {
  return nodeId.split(/[=./]/).at(-1) ?? nodeId;
}
function stripNamespace(value: string | undefined): string | undefined {
  return value?.replace(/^\d+:/, '');
}
function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function addFinding(
  target: CommissioningDiscoveryResult['findings']['warnings'],
  finding: CommissioningDiscoveryResult['findings']['warnings'][number],
): void {
  if (!target.some((item) => item.code === finding.code && item.area === finding.area))
    target.push(finding);
}
function sortFindings(findings: CommissioningDiscoveryResult['findings']['warnings']) {
  return findings.sort((left, right) =>
    `${left.code}\0${left.area}`.localeCompare(`${right.code}\0${right.area}`),
  );
}
