/**
 * Purpose-built commissioning discovery seam.
 *
 * Command and report workflows should consume this model instead of depending on
 * node-opcua protocol objects, raw AttributeIds, or Data Access Property lookup
 * mechanics. Adapter implementations are responsible for translating OPC UA
 * reads/browses into these sanitized facts and evidence records.
 */
export interface CommissioningDiscoveryGateway {
  discoverCommissioning(
    request: CommissioningDiscoveryRequest,
  ): Promise<CommissioningDiscoveryResult>;
}

export interface CommissioningDiscoveryRequest {
  roots: string[];
  maxDepth?: number;
  maxNodes?: number;
}

export interface CommissioningDiscoveryResult {
  generatedAt: string;
  roots: CommissioningRootCoverage[];
  nodes: CommissioningNode[];
  suggestedReadEntryPoints: SuggestedReadEntryPoint[];
  draftSemanticControls: DraftSemanticControlCandidate[];
  writableButNotSuggested: WritableButNotSuggestedNode[];
  findings: CommissioningFindings;
  coverage: CommissioningCoverageSummary;
}

export interface CommissioningNode {
  identity: CommissioningNodeIdentity;
  nodeClass?: Evidence<CommissioningNodeClass>;
  description?: Evidence<string>;
  valueShape?: CommissioningValueShape;
  dataType?: CommissioningDataTypeFact;
  access?: CommissioningAccessFacts;
  dataAccess?: DataAccessPropertyFacts;
  partialFailures?: CommissioningFieldFailure[];
}

export interface CommissioningNodeIdentity {
  nodeId: string;
  browseName?: string;
  displayName?: string;
  path?: string[];
  typeDefinition?: string;
}

export type CommissioningNodeClass =
  | 'Object'
  | 'Variable'
  | 'Method'
  | 'ObjectType'
  | 'VariableType'
  | 'ReferenceType'
  | 'DataType'
  | 'View';

export interface CommissioningValueShape {
  kind: 'scalar' | 'array' | 'matrix' | 'unknown';
  valueRank?: number;
  arrayDimensions?: number[];
  evidence?: Evidence<'scalar' | 'array' | 'matrix' | 'unknown'>;
}

export interface CommissioningDataTypeFact {
  opcuaName: string;
  mappedType?: CommissioningSupportedControlDataType;
  evidence: Evidence<string>;
}

export type CommissioningSupportedControlDataType =
  | 'Boolean'
  | 'SByte'
  | 'Byte'
  | 'Int16'
  | 'UInt16'
  | 'Int32'
  | 'UInt32'
  | 'Float'
  | 'Double'
  | 'String';

export interface CommissioningAccessFacts {
  readable?: Evidence<boolean>;
  writable?: Evidence<boolean>;
  callable?: Evidence<boolean>;
  access?: Evidence<DecodedAccessFlags>;
  userAccess?: Evidence<DecodedAccessFlags>;
  executable?: Evidence<boolean>;
  userExecutable?: Evidence<boolean>;
}

export interface DecodedAccessFlags {
  currentRead?: boolean;
  currentWrite?: boolean;
  historyRead?: boolean;
  historyWrite?: boolean;
  semanticChange?: boolean;
  statusWrite?: boolean;
  timestampWrite?: boolean;
}

export interface DataAccessPropertyFacts {
  engineeringUnits?: Evidence<EngineeringUnitsFact>;
  euRange?: Evidence<NumericRangeFact>;
  instrumentRange?: Evidence<NumericRangeFact>;
  enumStrings?: Evidence<string[]>;
  enumValues?: Evidence<EnumValueFact[]>;
}

export interface EngineeringUnitsFact {
  displayName?: string;
  description?: string;
  unitId?: number;
  namespaceUri?: string;
}

export interface NumericRangeFact {
  low: number;
  high: number;
}

export interface EnumValueFact {
  value: number | string;
  displayName?: string;
  description?: string;
}

export interface Evidence<T> {
  value: T;
  source: CommissioningEvidenceSource;
  status: SanitizedOpcUaStatus;
  observedAt?: string;
}

export type CommissioningEvidenceSource =
  'browse' | 'metadata_read' | 'data_access_property' | 'derived' | 'configured_root';

export interface SanitizedOpcUaStatus {
  severity: 'good' | 'uncertain' | 'bad' | 'unknown';
  code: string;
  message?: string;
}

export interface CommissioningFieldFailure {
  field: CommissioningMetadataField;
  status: SanitizedOpcUaStatus;
}

export type CommissioningMetadataField =
  | 'NodeClass'
  | 'BrowseName'
  | 'DisplayName'
  | 'Description'
  | 'DataType'
  | 'ValueRank'
  | 'ArrayDimensions'
  | 'AccessLevel'
  | 'UserAccessLevel'
  | 'Executable'
  | 'UserExecutable'
  | 'EngineeringUnits'
  | 'EURange'
  | 'InstrumentRange'
  | 'EnumStrings'
  | 'EnumValues';

export interface SuggestedReadEntryPoint {
  nodeId: string;
  suggestedLabel: string;
  displayName?: string;
  reason: ReadEntryPointSuggestionReason;
  evidence: Evidence<unknown>[];
}

export type ReadEntryPointSuggestionReason =
  'requested_root' | 'readable_branch' | 'high_level_object' | 'operator_review_required';

export interface DraftSemanticControlCandidate {
  nodeId: string;
  suggestedName: string;
  suggestedGroup?: string;
  description?: string;
  dataType: CommissioningSupportedControlDataType;
  unit?: string;
  normalRange?: NumericRangeFact;
  enumValues?: DraftEnumValueHint[];
  draftState: 'inactive_review_required';
  eligibility: 'eligible' | 'needs_operator_review';
  reasons: SemanticControlCandidateReason[];
  evidence: Evidence<unknown>[];
}

export interface DraftEnumValueHint extends EnumValueFact {
  suggestedLabel: string;
}

export type SemanticControlCandidateReason =
  | 'scalar_supported_data_type'
  | 'session_writable'
  | 'named_variable'
  | 'has_engineering_units'
  | 'has_normal_range'
  | 'has_enum_values'
  | 'operator_safety_fields_required';

export interface WritableButNotSuggestedNode {
  nodeId: string;
  displayName?: string;
  dataType?: string;
  reasons: WritableNotSuggestedReason[];
  evidence: Evidence<unknown>[];
}

export type WritableNotSuggestedReason =
  | 'unsupported_data_type'
  | 'array_value_shape'
  | 'missing_data_type'
  | 'missing_identity_context'
  | 'method_calls_out_of_scope'
  | 'arbitrary_string_requires_allowed_values'
  | 'operator_review_required';

export interface CommissioningFindings {
  blocking: CommissioningFinding[];
  warnings: CommissioningFinding[];
}

export interface CommissioningFinding {
  code: CommissioningFindingCode;
  area: string;
  message: string;
  evidence?: Evidence<unknown>[];
}

export type CommissioningFindingCode =
  | 'root_browse_failed'
  | 'partial_discovery'
  | 'metadata_read_failed'
  | 'missing_engineering_units'
  | 'range_requires_operator_confirmation'
  | 'writable_not_suggested'
  | 'methods_out_of_scope'
  | 'max_nodes_reached'
  | 'max_depth_reached';

export interface CommissioningRootCoverage {
  nodeId: string;
  status: 'succeeded' | 'partial' | 'failed';
  nodesVisited: number;
  depthReached: number;
  statusDetail?: SanitizedOpcUaStatus;
}

export interface CommissioningCoverageSummary {
  requestedRoots: number;
  succeededRoots: number;
  failedRoots: number;
  nodesVisited: number;
  maxNodes: number;
  depthRequested: number;
  depthReached: number;
  fields: Partial<Record<CommissioningMetadataField, CommissioningFieldCoverage>>;
}

export interface CommissioningFieldCoverage {
  succeeded: number;
  failed: number;
  notPresent: number;
}
