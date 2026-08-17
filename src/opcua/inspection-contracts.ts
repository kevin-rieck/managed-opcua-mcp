export type InspectionErrorCode =
  | 'ambiguous_source'
  | 'connection_changed'
  | 'invalid_continuation'
  | 'invalid_request'
  | 'invalid_selector'
  | 'node_not_found'
  | 'opcua_access_denied'
  | 'opcua_operation_failed'
  | 'operation_cancelled'
  | 'operation_timeout'
  | 'request_limit_exceeded'
  | 'response_limit_exceeded'
  | 'server_busy'
  | 'unsupported_value';

export interface InspectionError {
  code: InspectionErrorCode;
  message: string;
  statusCode?: string;
}

export interface InspectionFailure {
  ok: false;
  error: InspectionError;
}

export interface LiveResult {
  ok: true;
  observedAt: string;
  connectionGeneration: number;
}

export type FieldOutcome<T> =
  | {
      state: 'present';
      value: T;
      source?: QualifiedNodeIdentity;
      statusCode?: string;
    }
  | { state: 'not_present'; statusCode?: string }
  | {
      state: 'denied' | 'failed' | 'unsupported';
      code: string;
      message: string;
      statusCode?: string;
    };

export interface QualifiedNodeIdentity {
  nodeId: string;
  namespaceIndex: number;
  namespaceUri: FieldOutcome<string>;
}

export interface QualifiedNameIdentity {
  namespaceIndex: number;
  name: string;
  namespaceUri: FieldOutcome<string>;
}

export interface ResolvedNodeIdentity extends QualifiedNodeIdentity {
  name: FieldOutcome<string>;
}

export interface LocalizedTextValue {
  text: string;
  locale?: string;
}

export type NodeSelector = { nodeId: string; label?: never } | { label: string; nodeId?: never };

export type NodeClass =
  | 'Object'
  | 'Variable'
  | 'Method'
  | 'ObjectType'
  | 'VariableType'
  | 'ReferenceType'
  | 'DataType'
  | 'View';

export type BrowseDirection = 'forward' | 'inverse' | 'both';
export type ReferenceScope = 'hierarchical' | 'all';

export interface NewBrowseRequest {
  selector: NodeSelector;
  direction?: BrowseDirection;
  referenceScope?: ReferenceScope;
  targetNodeClasses?: NodeClass[];
  depth?: number;
  pageSize?: number;
  continuation?: never;
}

export interface ContinueBrowseRequest {
  continuation: string;
  selector?: never;
  direction?: never;
  referenceScope?: never;
  targetNodeClasses?: never;
  depth?: never;
  pageSize?: never;
}

export type BrowseRequest = NewBrowseRequest | ContinueBrowseRequest;

export interface BrowsePathEdge {
  sourceNodeId: string;
  targetNodeId: string;
  referenceTypeNodeId: string;
  direction: 'forward' | 'inverse';
}

export interface BrowseEdge {
  source: QualifiedNodeIdentity;
  target: QualifiedNodeIdentity;
  referenceType: ResolvedNodeIdentity;
  direction: 'forward' | 'inverse';
  targetBrowseName: FieldOutcome<QualifiedNameIdentity>;
  targetDisplayName: FieldOutcome<LocalizedTextValue>;
  targetNodeClass: FieldOutcome<NodeClass>;
  depth: number;
  path: BrowsePathEdge[];
  targetPreviouslySeen: boolean;
  cycle: boolean;
}

export interface BrowseSuccess extends LiveResult {
  start: QualifiedNodeIdentity;
  edges: BrowseEdge[];
  complete: boolean;
  incompleteReasons: string[];
  continuation?: string;
}

export type BrowseResult = BrowseSuccess | InspectionFailure;

export type InspectRequest =
  { selector: NodeSelector; selectors?: never } | { selectors: NodeSelector[]; selector?: never };

export type ItemState = 'success' | 'partial' | 'failed';

export interface AccessLevelValue {
  raw: number;
  currentRead: boolean;
  currentWrite: boolean;
  historyRead: boolean;
  historyWrite: boolean;
  semanticChange: boolean;
  statusWrite: boolean;
  timestampWrite: boolean;
}

export interface RangeValue {
  low: number;
  high: number;
}

export interface EngineeringUnitValue {
  namespaceUri: string;
  unitId: number;
  displayName: LocalizedTextValue;
  description: LocalizedTextValue;
}

export interface EnumValue {
  value: { int64: string };
  displayName: LocalizedTextValue;
  description: LocalizedTextValue;
}

export interface InspectFields {
  browseName: FieldOutcome<QualifiedNameIdentity>;
  nodeClass: FieldOutcome<NodeClass>;
  displayName: FieldOutcome<LocalizedTextValue>;
  description: FieldOutcome<LocalizedTextValue>;
  typeDefinition: FieldOutcome<ResolvedNodeIdentity>;
  dataType: FieldOutcome<ResolvedNodeIdentity>;
  valueRank: FieldOutcome<number>;
  accessLevel: FieldOutcome<AccessLevelValue>;
  userAccessLevel: FieldOutcome<AccessLevelValue>;
  executable: FieldOutcome<boolean>;
  userExecutable: FieldOutcome<boolean>;
  currentlyReadable: FieldOutcome<boolean>;
  currentlyWritable: FieldOutcome<boolean>;
  currentlyExecutable: FieldOutcome<boolean>;
  engineeringUnits: FieldOutcome<EngineeringUnitValue>;
  euRange: FieldOutcome<RangeValue>;
  instrumentRange: FieldOutcome<RangeValue>;
  enumStrings: FieldOutcome<LocalizedTextValue[]>;
  enumValues: FieldOutcome<EnumValue[]>;
}

export interface InspectEntry {
  index: number;
  selector: NodeSelector;
  state: ItemState;
  identity: FieldOutcome<QualifiedNodeIdentity>;
  fields: InspectFields;
  error?: InspectionError;
}

export interface InspectSuccess extends LiveResult {
  items: InspectEntry[];
}

export type InspectResult = InspectSuccess | InspectionFailure;

export type ReadRequest =
  { selector: NodeSelector; selectors?: never } | { selectors: NodeSelector[]; selector?: never };

export interface TaggedInt64Value {
  type: 'Int64' | 'UInt64';
  value: string;
}

export interface TaggedByteStringValue {
  type: 'ByteString';
  value: string;
}

export interface TaggedDateTimeValue {
  type: 'DateTime';
  value: string;
}

export interface TaggedCanonicalValue {
  type: 'Guid' | 'NodeId' | 'ExpandedNodeId' | 'QualifiedName';
  value: string;
}

export interface TaggedLocalizedTextValue {
  type: 'LocalizedText';
  value: LocalizedTextValue;
}

export interface TaggedNonFiniteValue {
  type: 'FloatSpecial';
  value: 'NaN' | 'Infinity' | '-Infinity';
}

export type OpcUaJsonScalar =
  | null
  | boolean
  | number
  | string
  | TaggedInt64Value
  | TaggedByteStringValue
  | TaggedDateTimeValue
  | TaggedCanonicalValue
  | TaggedLocalizedTextValue
  | TaggedNonFiniteValue;

export type OpcUaJsonValue = OpcUaJsonScalar | OpcUaJsonScalar[];
export type ValueConversionOutcome =
  { state: 'converted' } | { state: 'failed' | 'unsupported'; code: string; message: string };

export interface ReadValueEntry {
  index: number;
  selector: NodeSelector;
  state: 'success' | 'partial';
  identity: QualifiedNodeIdentity;
  dataType: FieldOutcome<ResolvedNodeIdentity>;
  statusCode: string;
  quality: 'good' | 'uncertain' | 'bad';
  usable: boolean;
  value: FieldOutcome<OpcUaJsonValue>;
  conversion: ValueConversionOutcome;
  sourceTimestamp?: string;
  serverTimestamp?: string;
  error?: InspectionError;
}

export interface FailedReadEntry {
  index: number;
  selector: NodeSelector;
  state: 'failed';
  error: InspectionError;
  identity?: QualifiedNodeIdentity;
  statusCode?: string;
}

export type ReadEntry = ReadValueEntry | FailedReadEntry;

export interface ReadSuccess extends LiveResult {
  items: ReadEntry[];
}

export type ReadResult = ReadSuccess | InspectionFailure;

export interface NamespaceModelMetadata {
  modelUri: FieldOutcome<string>;
  version: FieldOutcome<string>;
  publicationDate: FieldOutcome<string>;
}

export interface NamespaceContext {
  namespaceIndex: number;
  namespaceUri: FieldOutcome<string>;
  metadata: FieldOutcome<NamespaceModelMetadata>;
}

export interface ModelContextSuccess extends LiveResult {
  namespaces: NamespaceContext[];
  complete: boolean;
  limitReason?: 'response_size';
}

export type ModelContextResult = ModelContextSuccess | InspectionFailure;

export interface OpcUaInspectionModule {
  browse(request: BrowseRequest, signal?: AbortSignal): Promise<BrowseResult>;
  inspect(request: InspectRequest, signal?: AbortSignal): Promise<InspectResult>;
  read(request: ReadRequest, signal?: AbortSignal): Promise<ReadResult>;
  modelContext(signal?: AbortSignal): Promise<ModelContextResult>;
}
