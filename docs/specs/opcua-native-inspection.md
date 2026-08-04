# OPC UA-native inspection specification

- Status: **Normative next-release specification**
- Scope: read-only inspection and MCP projection
- Decision sources: GitHub issues #23–#34

## 1. Purpose and precedence

This specification defines the implementation contract for the next release of the Managed OPC UA MCP Server. It is the implementation input for a deep, read-only OPC UA inspection slice. Capitalized domain terms have the meanings in [`CONTEXT.md`](../../CONTEXT.md).

The following words are normative: **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY**.

Where this specification conflicts with the current read and browse behavior described in `docs/plan.md`, `docs/prd.md`, or current production code, this specification controls the next release. In particular:

- issue #29 supersedes the maintained Semantic Layer, generated equipment view, stable semantic identity, and NodeId-free assumptions explored in #24–#28 and #31;
- issue #32 fixes the release feature set and source-trust behavior;
- issue #33 fixes the architecture, runtime behavior, limits, and acceptance strategy;
- the existing Control Surface remains governed by the current plan, PRD, and ADRs;
- this issue produces a specification only. Production implementation is a later task.

The release MAY make clean changes to unreleased MCP contracts. Existing configuration files that pass the current schema MUST continue to parse. Legacy `defaultBrowseDepth` and `maxBrowseDepth` values above the new hard cap remain schema-valid but are bounded at runtime as specified in section 13; this compatibility rule does not permit an operation to exceed a compiled cap.

## 2. Goals and source-trust model

The release MUST let an Agent:

1. obtain starting Nodes from configured Read Entry Points;
2. discover reference structure in hierarchical and sparse/flat OPC UA Server models;
3. inspect qualified Node and diagnostic metadata;
4. compare Nodes and read current values efficiently in correlated batches;
5. cite NodeIds, qualified identities, references, quality, timestamps, provenance, and discovery completeness;
6. report missing domain meaning as unknown rather than infer it.

OPC UA relationships, hierarchy, names, and descriptions are source evidence. They are not an inferred equipment model. The MCP Server MUST NOT infer equipment identity, ownership, serving relationships, units, boolean polarity, process meaning, authorization, or Control Catalog configuration.

NodeIds are valid Agent workflow identifiers. Read Entry Points guide navigation and are not an authorization boundary. The OPC UA Server remains authoritative for reads and underlying Control Operations.

OPC UA Server-provided text is untrusted data. It MUST be bounded and transport-safe, and MUST NOT be interpreted as an instruction, policy, authorization rule, or Semantic Control definition.

## 3. Release scope

The required vertical slice is:

- an evolved `browse_node` tool;
- new `inspect_node` and `inspect_nodes` tools;
- strengthened `read_node` and `read_nodes` tools;
- the existing `opcua://read-entry-points` resource;
- a new live `opcua://model-context` resource;
- an `OpcUaInspectionModule` behind thin MCP schemas and projections;
- deterministic protocol-backed acceptance fixtures and tests.

### 3.1 Agent workflow

The expected workflow is:

1. Read `opcua://read-entry-points`.
2. Browse a selected Read Entry Point or direct NodeId with bounded filters.
3. Treat every edge as reported source evidence, including direction and ReferenceType.
4. Inspect candidate Nodes, preserving partial field outcomes and provenance.
5. Batch-read current values and assess quality and timestamps.
6. State a relationship is absent only after a relevant browse reports `complete: true`. Otherwise report it as unknown from available source evidence.
7. Use the unchanged Control Catalog if a Control Operation is required; discovered writability never creates a Control Operation.

### 3.2 Operator impact

No maintained Operator-authored Semantic Layer or equipment model is introduced. Operator work remains limited to:

- connection credentials and OPC UA Server roles;
- optional Read Entry Points;
- optional read-only defensive limits in section 13;
- the unchanged Control Catalog and its existing safety lifecycle.

Omitting all new settings is valid. Omitted `maxBrowseDepth` now defaults to 5 rather than the current 10. Explicit legacy depth settings remain parse-compatible; their active values are bounded by the compiled cap of 10.

## 4. Explicit non-goals

This release MUST NOT add:

- generated equipment views or a maintained Operator-authored Semantic Layer;
- inferred domain relationships or ontology mapping;
- full-text/fuzzy search or maintained indexes;
- arbitrary AttributeId reads;
- custom structure, general ExtensionObject, or matrix decoding;
- historical reads, subscriptions, monitored items, events, or alarms;
- method calls or raw writes;
- multiple OPC UA Server endpoints per MCP Server process;
- Companion Specification-specific adapters;
- generated, versioned, or task-specific MCP tools;
- persistent or cross-session metadata caching;
- new read authorization configuration;
- read-only Control Attempt auditing;
- any weakening of Control Catalog, Control Confirmation, Control Attempt audit, Write Verification, cooldown, or fail-closed behavior.

## 5. Architecture and ownership

Production code MUST expose an `OpcUaInspectionModule` equivalent to:

```ts
interface OpcUaInspectionModule {
  browse(request: BrowseRequest, signal?: AbortSignal): Promise<BrowseResult>;
  inspect(request: InspectRequest, signal?: AbortSignal): Promise<InspectResult>;
  read(request: ReadRequest, signal?: AbortSignal): Promise<ReadResult>;
  modelContext(signal?: AbortSignal): Promise<ModelContextResult>;
}
```

Exact source file names are implementation freedom. The following capability boundaries are not:

### 5.1 OPC UA protocol adapter

`src/opcua/` MUST own:

- active-session leases and connection-generation identity;
- Browse and BrowseNext service calls;
- genuine batch Read service calls;
- NamespaceArray and NamespaceMetadata protocol access;
- canonical mapping of protocol results and exact StatusCodes;
- release of native continuation points on every terminal path.

The adapter MUST NOT apply Agent-facing traversal, Semantic Control normalization, or equipment semantics.

### 5.2 Inspection module

The inspection module MUST own:

- Read Entry Point selector resolution;
- traversal and deterministic ordering;
- opaque MCP cursors and response replay;
- the fixed inspection plan;
- namespace and qualified-identity resolution;
- StatusCode classification and JSON-safe value encoding;
- effective limits, response accounting, concurrency, and deadlines;
- connection-generation fencing and cancellation cleanup.

### 5.3 MCP projection

`src/mcp/` MUST contain thin input schemas and output projections. Singleton inspect/read tools MUST call the same batch implementation with one item. MCP projection MUST NOT reclassify quality, infer missing data, normalize Semantic Control values, or add Control Catalog units.

The identifier-less form of `browse_node` and the deprecated `opcua://read-scope` alias MUST be removed. The retained `opcua://read-entry-points` resource is the only entry-point resource.

### 5.4 Control separation

A connection owner MAY implement both the read-only inspection adapter and existing control adapter, but neither capability interface may expose the other. Inspection code MUST have no dependency on Control Catalog evaluation, Control Confirmation, Control Attempt audit, value normalization, or write methods.

## 6. Shared wire types

The TypeScript structural definitions below are the normative JSON data schemas: unions are `oneOf`, optional (`?`) properties are not required, and `never` properties are forbidden. Every defined object is closed (`additionalProperties: false`). Properties not marked optional are REQUIRED. Implementations MUST NOT add undocumented properties to these next-release contracts. Registered MCP schemas MAY reject non-object/non-string/non-array JSON types at protocol validation; semantic rules described here return structured results.

### 6.1 Selector

```ts
type SelectorInput = { nodeId?: string; label?: string };
type Selector = { nodeId: string; label?: never } | { label: string; nodeId?: never };
```

MCP schemas accept `SelectorInput` so a conflicting or missing selector in a batch can receive a correlated outcome. After semantic validation, a selector MUST satisfy `Selector` by containing exactly one field. `label` resolves only a configured Read Entry Point label. It MUST NOT resolve a Semantic Control name. A NodeId input is at most 4,096 characters and MUST be parsed before any OPC UA gateway call.

### 6.2 Observation

```ts
type Observation = {
  startedAt: string; // UTC ISO-8601 instant
  completedAt: string; // UTC ISO-8601 instant, >= startedAt
  connectionGeneration: number; // non-negative safe integer
};
```

Observation time is an interval, not a claim that every field was sampled at one instant. Every result that acquired a live session MUST include `observation`. A pre-session validation/capacity failure MAY omit it.

If the generation differs at any point between lease acquisition and result finalization, the entire request MUST fail with `connection_changed`; no result may mix generations.

### 6.3 StatusCode

```ts
type StatusCode = {
  value: number; // unsigned 32-bit integer
  hex: string; // exactly "0x" plus 8 lowercase hexadecimal digits
  name: string; // canonical SDK name, or "Unknown"
};
```

The numeric value is authoritative. Names MUST NOT replace or alter it.

### 6.4 Stable errors

```ts
type InspectionError = {
  code: ErrorCode;
  message: string;
  statusCode?: StatusCode;
};
```

`message` MUST be a sanitized, single-line string of at most 1,024 Unicode scalar values. It MUST NOT contain a stack, credentials, endpoint secrets, native continuation points, cursor tokens, or unsanitized SDK text.

`ErrorCode` is the following closed vocabulary for this release:

```text
invalid_request
invalid_selector
node_id_too_long
invalid_node_id
unknown_read_entry_point
batch_empty
batch_too_large
depth_out_of_range
page_size_out_of_range
invalid_continuation
continuation_expired
continuation_generation_changed
cursor_capacity_exceeded
response_limit_exceeded
server_busy
deadline_exceeded
cancelled
disconnected
connection_changed
opcua_access_denied
opcua_node_not_found
opcua_attribute_not_supported
opcua_service_error
opcua_operation_error
qualification_failed
ambiguous_source
bad_status
unsupported_data_type
unsupported_value_shape
array_limit_exceeded
value_limit_exceeded
invalid_source_value
internal_error
```

Unknown OPC UA failures map to `opcua_service_error` for a service-level failure or `opcua_operation_error` for a correlated operation/attribute failure, with the exact StatusCode retained. `internal_error` is reserved for unexpected implementation defects and MUST NOT expose internals.

### 6.5 Request results

```ts
type RequestFailure = {
  ok: false;
  error: InspectionError;
  observation?: Observation;
};

type ItemState = 'success' | 'partial' | 'failed';
```

`ok: false` means the operation could not run or could not produce a coherent response. `ok: true` means the operation ran; individual items or fields may still fail. Expected failures use these structured tool bodies. MCP protocol errors are reserved for JSON values that cannot satisfy the registered top-level tool schema, unexpected server defects, or SDK/transport failure.

### 6.6 Field outcomes and provenance

```ts
type ProvenanceNodeIdentity = {
  text: string;
  namespaceIndex: number | null;
  namespaceUri: string | null;
  serverIndex?: number;
};

type AttributeProvenance = {
  sourceKind: 'attribute';
  nodeId: ProvenanceNodeIdentity;
  attribute:
    | 'NodeId'
    | 'BrowseName'
    | 'NodeClass'
    | 'DisplayName'
    | 'Description'
    | 'DataType'
    | 'ValueRank'
    | 'AccessLevel'
    | 'UserAccessLevel'
    | 'Executable'
    | 'UserExecutable'
    | 'Value';
  statusCode: StatusCode;
};

type ReferenceProvenance = {
  sourceKind: 'reference';
  sourceNodeId: ProvenanceNodeIdentity;
  referenceTypeNodeId: ProvenanceNodeIdentity;
  direction: 'forward' | 'inverse';
  targetNodeId: ProvenanceNodeIdentity;
};

type Provenance = AttributeProvenance | ReferenceProvenance;

type FieldOutcome<T> =
  | { state: 'present'; value: T; provenance?: Provenance; clipped?: boolean; sanitized?: boolean }
  | { state: 'not_present' }
  | { state: 'denied'; error: InspectionError }
  | { state: 'failed'; error: InspectionError }
  | { state: 'unsupported'; error: InspectionError };
```

`not_present` is legal only when the implementation positively established absence. A denied, incomplete, ambiguous, or failed lookup MUST NOT be projected as `not_present`. `clipped` and `sanitized` are present and `true` only when applicable; they are never `false`.

Present `FieldOutcome` values obtained from an OPC UA Attribute or a separately discovered reference MUST carry the provenance by which they were obtained. A namespace URI resolved from NamespaceArray carries Value-attribute provenance for the standard NamespaceArray Node. Derived convenience indicators MAY omit provenance because their source outcomes remain in the same item. Browse `root`, edge `source`/`target`/`referenceType`, and `path` are structural evidence in the enclosing `BrowseEdge`, not `FieldOutcome` values, and therefore do not duplicate provenance. `not_present` has no provenance.

Operation-specific item-state algorithms are normative in sections 9.2 and 10.1; implementations MUST NOT infer state from an undefined notion of field importance.

### 6.7 Qualified identifiers

```ts
type QualifiedNodeId = {
  kind: 'node_id';
  text: string; // canonical local NodeId text using its namespace index
  namespaceIndex: number;
  namespaceUri: FieldOutcome<string>;
};

type QualifiedExpandedNodeId = {
  kind: 'expanded_node_id';
  text: string; // canonical ExpandedNodeId text
  namespaceIndex: number | null;
  namespaceUri: FieldOutcome<string>;
  serverIndex: number; // unsigned 32-bit integer; zero is retained
};

type QualifiedNodeIdentity = QualifiedNodeId | QualifiedExpandedNodeId;

type QualifiedName = {
  text: string; // `${namespaceIndex}:${name}`
  namespaceIndex: number;
  name: string;
  namespaceUri: FieldOutcome<string>;
};

type QualifiedTypeIdentity = {
  nodeId: QualifiedNodeIdentity;
  browseName: FieldOutcome<QualifiedName>;
};

type QualifiedReferenceType = QualifiedTypeIdentity;
```

Indexed identity MUST survive namespace URI or browse-name resolution failure. Canonical NodeId text uses OPC UA Part 6 textual syntax with lowercase `ns=`, `i=`, `s=`, `g=`, and `b=` keys; namespace zero omits `ns=0;`. ByteString identifiers use base64 and GUID identifiers use lowercase canonical hyphenated text. Canonical ExpandedNodeId text uses the same identifier followed by `;svr=<unsigned decimal>` when the server index is nonzero and uses `nsu=<percent-encoded-uri>;` instead of `ns=<index>;` when the source identity supplies a namespace URI without a usable local index. `namespaceIndex` is then `null`. The original server index is always retained in `serverIndex`.

A local source, root, property, or provenance Node MUST use `QualifiedNodeId`. A browse target and TypeDefinition MAY use `QualifiedExpandedNodeId`. Namespace indexes absent from NamespaceArray produce a failed `namespaceUri` outcome with `qualification_failed`; they do not erase the indexed identifier.

### 6.8 Text handling

Limits are measured in Unicode scalar values after replacing malformed UTF-16 with U+FFFD. The implementation MUST remove C0 controls except tab, line feed, and carriage return, and MUST remove DEL and C1 controls. JSON escaping is then applied normally.

- QualifiedName `name` and BrowseName components: 512 scalars.
- DisplayName: 1,024 scalars.
- Description, EUInformation text, XML metadata, and other free metadata text: 4,096 scalars.
- Namespace/model URIs: 4,096 scalars.
- Namespace version and locale strings: 1,024 and 128 scalars respectively.

Clipping occurs after sanitization and MUST set `clipped: true`; any replacement or removal MUST set `sanitized: true`. Text is never interpreted as Markdown or instructions. Read String and XmlElement values are not metadata and MUST NOT be clipped; section 10.2 defines their all-or-nothing bound.

## 7. MCP surface

All five tools use `readOnlyHint: true` and `openWorldHint: true`.

### 7.1 Tool inputs

```ts
type BrowseNodeInput =
  | {
      nodeId?: string;
      label?: string;
      direction?: 'forward' | 'inverse' | 'both'; // default forward
      referenceScope?: 'hierarchical' | 'all'; // default hierarchical
      nodeClasses?: NodeClass[]; // omitted = all
      depth?: number; // default configured
      pageSize?: number; // default configured
      continuation?: never;
    }
  | {
      continuation: string;
      nodeId?: never;
      label?: never;
      direction?: never;
      referenceScope?: never;
      nodeClasses?: never;
      depth?: never;
      pageSize?: never;
    };

type InspectNodeInput = SelectorInput;
type InspectNodesInput = { identifiers: SelectorInput[] };
type ReadNodeInput = SelectorInput;
type ReadNodesInput = { identifiers: SelectorInput[] };

type NodeClass =
  | 'Object'
  | 'Variable'
  | 'Method'
  | 'ObjectType'
  | 'VariableType'
  | 'ReferenceType'
  | 'DataType'
  | 'View';
```

For a non-continuation browse, exactly one of `nodeId` or `label` is required. `nodeClasses`, if present, MUST be non-empty and contain no duplicates. Depth is an integer from 0 through effective `maxBrowseDepth`; depth 0 is valid and returns no edges with `complete: true`. Page size is an integer from 1 through effective `maxBrowsePageSize`.

A continuation request contains only the token. It cannot modify the normalized original query.

Batch arrays MUST be non-empty and no larger than the effective operation batch limit. Input order and duplicates are preserved. Every selector is validated before any OPC UA call. A malformed selector inside an otherwise valid batch produces a correlated failed item; an empty/oversized batch or invalid batch envelope is a request failure.

### 7.2 Resources

The retained `opcua://read-entry-points` resource is non-live and has this closed body:

```ts
type ReadEntryPointsResourceResult = ReadEntryPointsResult | RequestFailure;

type ReadEntryPointsResult = {
  ok: true;
  roots: {
    nodeId: string;
    label?: string;
    description?: string;
  }[];
  browseDefaults: {
    depth: number;
    pageSize: number;
    maxDepth: number;
    maxPageSize: number;
  };
};
```

Roots retain configured order, including an empty array. Their strings are Operator configuration and are emitted as configured with normal JSON escaping; they are not OPC UA Server-provided text. Values in `browseDefaults` are the static effective configured/compiled values defined in section 13. Runtime Server-advertised limits are not included. If the complete serialized success body would exceed static effective `maxResponseBytes`, the resource returns request-level `response_limit_exceeded` without an observation; it MUST NOT truncate roots or strings. This preserves parse compatibility for legacy unbounded root configuration while making the operational misconfiguration explicit and keeping every response bounded. The resource MUST NOT imply a permission boundary or include unrelated batch/cursor/concurrency limits.

`opcua://model-context` is live and has the response contract in section 12. Resource read failures use the same JSON `RequestFailure` body rather than fabricated empty metadata. Both resources use MIME type `application/json` and return exactly one text content containing the serialized body.

All input objects are closed. A singleton conflicting/missing selector is request-level `invalid_selector`; the same selector in a structurally valid batch becomes a correlated failed item. Empty and oversized identifier arrays are accepted by the registered array shape so the handler can return `batch_empty` or `batch_too_large` rather than an MCP protocol error.

## 8. Browse contract

### 8.1 Result schema

```ts
type BrowseResult =
  | RequestFailure
  | {
      ok: true;
      observation: Observation;
      root: QualifiedNodeId;
      query: {
        direction: 'forward' | 'inverse' | 'both';
        referenceScope: 'hierarchical' | 'all';
        nodeClasses: NodeClass[] | null;
        depth: number;
        pageSize: number;
      };
      edges: BrowseEdge[];
      complete: boolean;
      incompleteReasons: BrowseIncompleteReason[];
      continuation?: string;
    };

type BrowseEdge = {
  ordinal: number; // zero-based occurrence in the complete normalized traversal
  source: QualifiedNodeId; // Node expanded by the traversal
  target: QualifiedNodeIdentity; // Node at the other end of this observed reference
  referenceType: QualifiedReferenceType;
  direction: 'forward' | 'inverse'; // reference direction relative to source
  depth: number; // target distance from root; first-hop edge is 1
  path: QualifiedNodeIdentity[]; // root followed by each target through this edge
  targetBrowseName: FieldOutcome<QualifiedName>;
  targetDisplayName: FieldOutcome<LocalizedText>;
  targetNodeClass: FieldOutcome<NodeClass>;
  targetTypeDefinition: FieldOutcome<QualifiedTypeIdentity>;
  repeatedNode: boolean;
  cycle: boolean;
};

type BrowseIncompleteReason =
  | 'page_size'
  | 'response_size'
  | 'edge_limit'
  | 'reference_scan_limit'
  | 'node_expansion_limit'
  | 'service_call_limit'
  | 'branch_denied'
  | 'branch_failed';
```

`incompleteReasons` contains unique values in the order shown in the union above. `complete: true` requires an empty reason array and no continuation. `complete: false` requires at least one reason.

`continuation` is present only when traversal can resume. `page_size` and `response_size` are resumable. Compiled/configured traversal limits and denied/failed branches are terminal and do not produce a continuation unless the same page also stopped earlier for a resumable reason.

### 8.2 Traversal semantics

Browsing is deterministic, breadth-first, and edge-oriented. It MUST NOT return a deduplicated Node tree.

- `source` is always the Node currently expanded; `target` is the Node described by the reference, including for inverse references.
- Hierarchical scope uses the standard HierarchicalReferences family, including subtypes. `all` uses all ReferenceTypes.
- The NodeClass filter applies to targets; a filtered target is not returned or expanded.
- Every observed matching edge occurrence is returned, including duplicate/repeated edges.
- `repeatedNode` is true when the target NodeId appeared earlier as a root or target in this traversal.
- `cycle` is true when the target NodeId already occurs in this edge's `path` before the target is appended.
- A target previously expanded, or a cycle target, MUST NOT be expanded again. Its edge remains visible.
- A target with `serverIndex: 0` and a namespace URI that exactly maps to the active NamespaceArray is normalized to that local namespace index for subsequent Browse calls while its reported edge identity remains unchanged.
- A target with nonzero `serverIndex`, or with a namespace URI that cannot map to an active local index, remains visible but cannot be expanded by this single-endpoint MCP Server. If requested depth would require its expansion, add terminal `branch_failed`, return `complete: false`, and do not issue a Browse call for it. At the requested maximum depth it does not affect completeness.

For each breadth level, source Nodes are expanded in their queue order. References for one source are ordered lexicographically by: direction (`forward` before `inverse`), ReferenceType canonical NodeId UTF-8 bytes, target canonical NodeId UTF-8 bytes, target BrowseName namespace index/name, then original zero-based occurrence as the final tie-breaker. Source responses and native continuation chunks MUST be exhausted sufficiently to apply this ordering before emitting that source's edges. `ordinal` is assigned after filtering and ordering.

A path contains the root and the target Node of every traversed edge through the current edge. It preserves repeated/cyclic identity and MUST NOT be inferred from display names.

### 8.3 Completeness

`complete: true` means all references reachable within the requested direction, scope, NodeClass filter, and depth were successfully exhausted. It is not a statement about relationships outside those bounds.

Pagination, response truncation, any traversal limit, or any denied/failed branch makes `complete: false`. Consequently:

- a complete bounded result may support “no matching relationship was present within these explicit bounds”;
- an incomplete result cannot establish absence;
- neither result permits inferred ownership or serving relationships.

### 8.4 MCP cursor behavior

Cursor tokens MUST be cryptographically unpredictable, opaque, in-memory, and at least 128 bits of entropy. They are bound to the normalized query, generation, traversal state, response-accounting state, and owned native continuation points. Tokens MUST NOT embed native continuation points or secrets.

The first page may return token `T1`. The first call with `T1` computes and durably caches the exact serialized next response and successor token before replying. Every replay of `T1` before expiry returns byte-for-byte the same JSON bytes and successor. Concurrent calls with the same token coalesce onto that computation. They do not double-advance. Cancelling one waiter does not cancel shared computation while another waiter remains. Cancelling the sole waiter cancels the computation and invalidates that token. A completed structured failure is replayed byte-for-byte like a completed page; an aborted computation is not cached as a page.

Token expiry is fixed from issuance and does not slide on access. A consumed token's cached page remains replayable until expiry even if its page is terminal; terminal native continuation points are already released. Cursor and replay state is released on expiry, reconnect, related cancellation, or shutdown. Reconnect yields `continuation_generation_changed`; expiry yields `continuation_expired`; unknown/malformed tokens yield `invalid_continuation`.

If a successor is required but active-cursor or cursor-memory capacity is unavailable, the request fails with `cursor_capacity_exceeded`; the server MUST NOT evict another cursor or return an unresumable page as complete.

Native continuation points MUST be released on normal exhaustion, terminal limit, cursor expiry, reconnect, cancellation, invalidation, failure, and shutdown.

## 9. Inspection contract

### 9.1 Result schema

```ts
type InspectResult =
  | RequestFailure
  | {
      ok: true;
      observation: Observation;
      items: InspectItem[];
    };

type InspectItem = {
  index: number;
  selector: SelectorInput;
  status: ItemState;
  nodeId: FieldOutcome<QualifiedNodeId>;
  fields: {
    browseName: FieldOutcome<QualifiedName>;
    nodeClass: FieldOutcome<NodeClass>;
    displayName: FieldOutcome<LocalizedText>;
    description: FieldOutcome<LocalizedText>;
    typeDefinition: FieldOutcome<QualifiedTypeIdentity>;
    dataType: FieldOutcome<QualifiedTypeIdentity>;
    valueRank: FieldOutcome<number>;
    accessLevel: FieldOutcome<AccessLevel>;
    userAccessLevel: FieldOutcome<AccessLevel>;
    executable: FieldOutcome<boolean>;
    userExecutable: FieldOutcome<boolean>;
    currentReadable: FieldOutcome<boolean>;
    currentWritable: FieldOutcome<boolean>;
    currentExecutable: FieldOutcome<boolean>;
    engineeringUnits: FieldOutcome<EUInformation>;
    euRange: FieldOutcome<RangeValue>;
    instrumentRange: FieldOutcome<RangeValue>;
    enumStrings: FieldOutcome<LocalizedText[]>;
    enumValues: FieldOutcome<EnumValue[]>;
  };
  errors: InspectionError[];
};

type LocalizedText = { text: string; locale: string | null };

type AccessLevel = {
  raw: number; // unsigned byte
  flags: (
    | 'current_read'
    | 'current_write'
    | 'history_read'
    | 'history_write'
    | 'semantic_change'
    | 'status_write'
    | 'timestamp_write'
  )[];
  unknownBitsHex: string; // exactly 0x plus two lowercase hex digits
};

type EUInformation = {
  namespaceUri: string;
  unitId: number;
  displayName: LocalizedText;
  description: LocalizedText;
};

type RangeValue = { low: JsonValue; high: JsonValue };

type EnumValue = {
  value: { $opcua: 'Int64'; value: string };
  displayName: LocalizedText;
  description: LocalizedText;
};
```

Every batch item is returned exactly once with its zero-based input `index`, including duplicates and invalid selectors. `errors` is deduplicated by `(code, statusCode.value)` and ordered by the corresponding fixed field order above. It is a summary; field outcomes remain authoritative. A failed nested `browseName` inside an otherwise present qualified type identity also makes the item `partial`.

### 9.2 Fixed profile

Inspection MUST attempt the complete fixed profile. Fields that do not apply to the NodeClass are `not_present` only after NodeClass is successfully established. Attribute access denial/failure uses `denied`/`failed`.

- `typeDefinition` is resolved from an actual HasTypeDefinition reference.
- `dataType`, `valueRank`, `accessLevel`, and `userAccessLevel` apply to Variable/VariableType Nodes as defined by OPC UA.
- `executable` and `userExecutable` apply to Method Nodes.
- `currentReadable` is derived from both AccessLevel and UserAccessLevel current-read bits.
- `currentWritable` is derived from both current-write bits.
- `currentExecutable` is derived from both Executable and UserExecutable.

Convenience indicators use the following deterministic rule. When both source fields are present, return their logical AND. When either present source is `false`, return present `false` even if the other source is unavailable. Otherwise, if a source is denied, failed, or unsupported, propagate that outcome using precedence `denied`, `failed`, `unsupported`. Return `not_present` only when applicability or positive absence was established for both sources. Convenience indicators are current hints only. `false` does not prove permanent denial, and `true` does not authorize or guarantee a later operation. Every operation still relies on its OPC UA Server result.

TypeDefinition discovery returning exactly one HasTypeDefinition target is present. No target after complete successful discovery is `not_present`. Multiple targets are `failed` with `ambiguous_source`; denied or incomplete discovery is `denied` or `failed`, never absence.

An Inspect item is `failed` when `nodeId` is not present or NodeClass cannot be obtained because the selected Node itself is denied, missing, or failed. Otherwise it is `partial` when any applicable field is denied, failed, unsupported, clipped, or sanitized, including nested qualification; it is `success` only when all applicable fields are present or positively `not_present`.

### 9.3 Diagnostic properties

EngineeringUnits, EURange, InstrumentRange, EnumStrings, and EnumValues MUST be found only through a HasProperty relationship to the standard namespace-zero qualified BrowseName of that property. A vendor property with a matching unqualified display/name is not a substitute.

A present diagnostic field MUST include `provenance` pointing to the property Node's Value attribute and exact StatusCode. No matching standard property after complete successful property discovery is `not_present`. More than one matching standard property is `failed` with `ambiguous_source`; all candidate property NodeIds MAY be included only in the bounded error message, not an extra wire field. Incomplete, denied, or failed property discovery is `denied` or `failed`, never `not_present`.

Only standard EUInformation, Range, and EnumValueType ExtensionObjects are decoded. EnumStrings and EnumValues are one-dimensional arrays bounded by effective `maxArrayElements`; overflow is `failed` with `array_limit_exceeded`, with no truncated array. Every nested LocalizedText uses section 6.8. General or vendor ExtensionObjects return `unsupported` with `unsupported_data_type` or `unsupported_value_shape`. Technical ranges are diagnostic evidence and MUST NOT become process constraints, Semantic Control bounds, or safety policy.

## 10. Read contract

### 10.1 Result schema

```ts
type ReadResult =
  | RequestFailure
  | {
      ok: true;
      observation: Observation;
      items: ReadItem[];
    };

type ReadItem = {
  index: number;
  selector: SelectorInput;
  status: ItemState;
  nodeId: FieldOutcome<QualifiedNodeId>;
  dataType: FieldOutcome<ReadDataType>;
  quality: FieldOutcome<Quality>;
  sourceTimestamp: FieldOutcome<string>;
  serverTimestamp: FieldOutcome<string>;
  value: FieldOutcome<JsonValue>;
  usable: boolean;
  errors: InspectionError[];
};

type BuiltInType =
  | 'Null'
  | 'Boolean'
  | 'SByte'
  | 'Byte'
  | 'Int16'
  | 'UInt16'
  | 'Int32'
  | 'UInt32'
  | 'Int64'
  | 'UInt64'
  | 'Float'
  | 'Double'
  | 'String'
  | 'DateTime'
  | 'Guid'
  | 'ByteString'
  | 'XmlElement'
  | 'NodeId'
  | 'ExpandedNodeId'
  | 'StatusCode'
  | 'QualifiedName'
  | 'LocalizedText'
  | 'ExtensionObject'
  | 'DataValue'
  | 'Variant'
  | 'DiagnosticInfo';

type ReadDataType = {
  builtIn: BuiltInType;
  identity: FieldOutcome<QualifiedTypeIdentity>;
};

type Quality = {
  class: 'good' | 'uncertain' | 'bad';
  statusCode: StatusCode;
};
```

Timestamps are UTC ISO-8601 instants. A timestamp absent from a successfully returned DataValue is positively `not_present`. Read results preserve input order and duplicates.

Good and Uncertain source quality with a successfully encoded value set `usable: true`; Uncertain remains explicit. Bad quality sets `usable: false`, retains quality and timestamps, and gives `value.state: "failed"` with `bad_status`. Encoding failure sets `usable: false` without changing the Server-reported quality.

A Read item is `failed` when `nodeId` is not present or no DataValue/StatusCode can be correlated because the Node read itself was denied, missing, or failed. With a correlated DataValue, it is `partial` for Bad quality, absent/unencodable/oversized value, failed datatype qualification, or any denied/failed/unsupported/clipped/sanitized outcome; it is `success` for Good or Uncertain quality when datatype, timestamps, and value are present or positively absent as applicable and the value is usable. Uncertain quality alone does not make an item partial.

Native reads MUST NOT apply configured Semantic Control labels, normalization, allowed-value mapping, boolean polarity, or units. Read-item `errors` are deduplicated by `(code, statusCode.value)` and ordered by `nodeId`, `dataType`, `quality`, `sourceTimestamp`, `serverTimestamp`, then `value`.

### 10.2 JSON-safe values

`JsonValue` is a JSON primitive, tagged scalar, or a one-dimensional array of those scalar forms:

```ts
type JsonScalar = null | boolean | number | string | TaggedScalar;
type JsonValue = JsonScalar | JsonScalar[];

type TaggedScalar =
  | { $opcua: 'Int64'; value: string }
  | { $opcua: 'UInt64'; value: string }
  | { $opcua: 'ByteString'; base64: string }
  | { $opcua: 'DateTime'; value: string }
  | { $opcua: 'Guid'; value: string }
  | { $opcua: 'NodeId'; value: string }
  | { $opcua: 'ExpandedNodeId'; value: string }
  | { $opcua: 'QualifiedName'; namespaceIndex: number; name: string }
  | { $opcua: 'LocalizedText'; locale: string | null; text: string }
  | { $opcua: 'StatusCode'; value: number; hex: string; name: string }
  | { $opcua: 'XmlElement'; value: string }
  | { $opcua: 'FloatSpecial'; value: 'NaN' | '+Infinity' | '-Infinity' };
```

Encoding rules are exact:

- Boolean, SByte, Byte, Int16, UInt16, Int32, UInt32, finite Float/Double, String, and Null use ordinary JSON scalars. A Null Variant has `builtIn: "Null"`, a present `value: null`, and a positively absent datatype identity.
- Int64/UInt64 use exact base-10 strings without leading `+` or unnecessary leading zeroes.
- ByteString uses standard padded base64.
- DateTime uses a UTC ISO-8601 string with `Z`.
- Guid uses lowercase canonical hyphenated text.
- NodeId/ExpandedNodeId use the canonical text rules in section 6.7.
- QualifiedName preserves namespace index and bounded/sanitized name.
- LocalizedText preserves locale; absent locale is `null`.
- StatusCode repeats the exact section 6.3 representation under its tag.
- XmlElement is bounded/sanitized source text and is not parsed or executed.
- non-finite Float/Double values use `FloatSpecial`.

The implementation MUST support one-dimensional arrays of supported scalars up to effective `maxArrayElements`. Read String and XmlElement scalar values are all-or-nothing and bounded to 4,096 Unicode scalar values after sanitization; overflow is `failed` with `value_limit_exceeded`. ByteString encoding and any scalar's serialized form must fit the complete response bound or fail/degrade with `response_limit_exceeded`. The implementation MUST NOT silently truncate, coerce, or lossy-stringify. Matrices (including nested JSON arrays), custom structures, DiagnosticInfo, DataValue/Variant nesting, general ExtensionObjects, unsupported built-in shapes, and oversized arrays return `unsupported`/`failed` with `unsupported_value_shape`, `unsupported_data_type`, or `array_limit_exceeded` as applicable.

### 10.3 Genuine batch behavior

One logical batch MUST use the fewest batch Read service calls allowed by:

1. effective `maxReadBatchSize` for Agent items;
2. the positive `ServerCapabilities.OperationLimits.MaxNodesPerRead` value, when available;
3. a safe active-generation learned limit.

Inspection attribute/property reads use the same protocol batching and learned `MaxNodesPerRead` limit, while `maxInspectBatchSize` bounds Agent items.

If a Read service call fails at service level with `BadTooManyOperations` or `BadEncodingLimitsExceeded`, and its chunk contains more than one operation, retry the untouched chunk at `floor(chunkSize / 2)`. Continue halving until success or size one. Cache the largest successful reduced size only for the active generation. At size one, correlate the failure to that operation and do not retry it. Other service or operation failures are not adaptive-limit signals. Learned limits clear on reconnect.

No logical batch may be implemented as concurrent singleton reads. Duplicate inputs remain duplicate correlated results even when protocol request construction internally shares safe qualification work.

## 11. Response accounting and degradation

Serialized response limits are measured as UTF-8 bytes of the complete JSON body, including envelope, observation, items, errors, and continuation token. The implementation MUST reserve envelope/correlation space before adding variable fields and MUST always emit valid JSON.

Browse stops before adding an edge that would exceed the effective response limit and returns a resumable cursor with `response_size` when capacity permits.

Inspect/read MUST preserve one item and its `index`, `selector`, `status`, `nodeId`, and `errors` for every input. When variable fields do not fit, replace fields in reverse fixed field order with:

```json
{
  "state": "failed",
  "error": {
    "code": "response_limit_exceeded",
    "message": "Field omitted because the bounded response would be exceeded."
  }
}
```

For read items the degradation order is `value`, `serverTimestamp`, `sourceTimestamp`, `dataType`, then `quality`; quality is retained whenever possible. For inspect items, use the reverse of the field order in section 9.1. A degraded item is `partial` or `failed` and `usable` becomes false if its value or quality is removed. If the complete correlation-only response cannot fit, return request-level `response_limit_exceeded`; never omit an item.

Model context includes only whole namespace entries that fit and follows section 12. Browse/model-context arrays and inspect/read fields are never cut mid-JSON or mid-string solely to fit the response; text's own semantic bounds are applied first.

## 12. Model context and caching

### 12.1 Resource result

```ts
type ModelContextResult =
  | RequestFailure
  | {
      ok: true;
      observation: Observation;
      namespaces: NamespaceEntry[];
      complete: boolean;
      limitReason?: 'response_size';
    };

type NamespaceEntry = {
  index: number;
  namespaceUri: FieldOutcome<string>;
  metadataNodeId: FieldOutcome<QualifiedNodeId>;
  modelUri: FieldOutcome<string>;
  version: FieldOutcome<string>;
  publicationDate: FieldOutcome<string>;
};
```

Entries are ordered by ascending namespace index and each index occurs once. `complete: true` forbids `limitReason`; `complete: false` requires `limitReason: "response_size"`. There is no model-context cursor.

Namespace mappings come from the live Server NamespaceArray. A present mapping's provenance is the standard Server NamespaceArray Node Value. A non-string/malformed entry produces a failed `namespaceUri`; duplicate URI strings remain distinct index entries. NamespaceMetadata is discovered only from standard NamespaceMetadataType objects organized under the standard Server Namespaces location and matched by the exact NamespaceUri property value. Present model URI/version/publication date fields carry provenance for the exact standard property Node Value; `metadataNodeId` carries NodeId provenance for the matched metadata object.

No matching metadata object after complete discovery makes metadata fields `not_present`. Multiple matching objects make those fields `failed` with `ambiguous_source`. Failure/denial to discover or read metadata yields corresponding field outcomes. `publicationDate` uses UTC ISO-8601. Missing or partial metadata never blocks browse, inspect, or read.

On response-size pressure, only complete `NamespaceEntry` objects are emitted; the result is incomplete with `response_size`.

### 12.2 Cache policy

Within one connection generation the implementation MAY cache only:

- the NamespaceArray index-to-URI mapping;
- canonical namespace-zero NodeIds and qualified names defined by the OPC UA specification.

For this release, custom Server-authored DataType, TypeDefinition, and ReferenceType names MUST be resolved live; no “positive stability evidence” mechanism is defined. The implementation MUST NOT cache Node attributes, source text, access/executable indicators, diagnostic properties, values, StatusCodes, timestamps, or NamespaceMetadata values.

All inspection caches clear on reconnect and shutdown. There is no persistent, cross-generation, or cross-process cache.

## 13. Configuration and effective limits

All new keys are optional direct children of the existing strict `read` object. Unknown fields remain invalid.

```yaml
read:
  defaultBrowseDepth: 1
  maxBrowseDepth: 5
  defaultBrowsePageSize: 100
  maxBrowsePageSize: 500
  maxBrowseEdges: 2000
  maxBrowseReferencesScanned: 10000
  maxBrowseNodesExpanded: 2000
  maxBrowseServiceCalls: 1000
  maxReadBatchSize: 50
  maxInspectBatchSize: 25
  maxArrayElements: 1000
  maxResponseBytes: 1048576
  cursorTtlMs: 120000
  maxActiveCursors: 100
  maxCursorMemoryBytes: 67108864
  maxConcurrentOperations: 16
  operationDeadlineMs: 30000
  roots: []
```

| Key                          |             Unit |   Minimum |    Default |             Compiled hard cap |
| ---------------------------- | ---------------: | --------: | ---------: | ----------------------------: |
| `defaultBrowseDepth`         |             hops |         0 |          1 |    effective `maxBrowseDepth` |
| `maxBrowseDepth`             |             hops |         0 |          5 |                            10 |
| `defaultBrowsePageSize`      |            edges |         1 |        100 | effective `maxBrowsePageSize` |
| `maxBrowsePageSize`          |            edges |         1 |        500 |                           500 |
| `maxBrowseEdges`             |      edges/query |         1 |      2,000 |                        10,000 |
| `maxBrowseReferencesScanned` | references/query |         1 |     10,000 |                        50,000 |
| `maxBrowseNodesExpanded`     |      Nodes/query |         1 |      2,000 |                        10,000 |
| `maxBrowseServiceCalls`      |      calls/query |         1 |      1,000 |                         5,000 |
| `maxReadBatchSize`           |      Agent items |         1 |         50 |                           500 |
| `maxInspectBatchSize`        |      Agent items |         1 |         25 |                           100 |
| `maxArrayElements`           |   elements/value |         1 |      1,000 |                        10,000 |
| `maxResponseBytes`           |      UTF-8 bytes |    16,384 |  1,048,576 |                     4,194,304 |
| `cursorTtlMs`                |     milliseconds |     1,000 |    120,000 |                       900,000 |
| `maxActiveCursors`           |          cursors |         1 |        100 |                         1,000 |
| `maxCursorMemoryBytes`       |            bytes | 1,048,576 | 67,108,864 |                   268,435,456 |
| `maxConcurrentOperations`    |       operations |         1 |         16 |                           100 |
| `operationDeadlineMs`        |     milliseconds |       100 |     30,000 |                       120,000 |

All values are integers. Config validation MUST enforce:

- `defaultBrowseDepth <= maxBrowseDepth`;
- `defaultBrowsePageSize <= maxBrowsePageSize`;
- every newly introduced value and `maxReadBatchSize` is within its minimum and hard cap;
- `maxCursorMemoryBytes >= maxResponseBytes`.

A **static effective limit** is the configured value (or default) bounded by its compiled hard cap. An **active runtime limit** is the static effective limit further bounded, where applicable, by a lower positive OPC UA Server-advertised or active-generation learned protocol limit. `MaxNodesPerRead` bounds protocol Read operations only; it does not change Agent item limits. No other Server-advertised mapping is defined in this release.

For parse compatibility, the legacy `defaultBrowseDepth` and `maxBrowseDepth` keys retain their current non-negative integer schema and `defaultBrowseDepth <= maxBrowseDepth` validation even when explicitly above 10. Their static effective values are `min(configuredDefault, configuredMaximum, 10)` and `min(configuredMaximum, 10)`, respectively, and validation MUST emit a non-secret warning when bounding occurs. Newly introduced keys and `maxReadBatchSize` MUST reject values above their listed hard caps. This is the sole exception to “every value is within its hard cap” at config-parse time.

Existing configuration files containing only current read keys therefore remain parse-valid. In the otherwise unchanged non-secret `opcua://config/summary` body, the `read` member MUST have the closed shape `{ configured, effective, roots }`: `configured` contains each explicitly supplied/defaulted numeric key from the YAML shape above, `effective` contains every numeric key in the table after static cap/cross-field bounding, and `roots` retains the configured Read Entry Points. Thus legacy values and their bounded runtime meaning are both visible. It MUST NOT report Server-advertised or transient learned limits, cursor contents, or pretend to know an active value while disconnected.

## 14. Failure, concurrency, cancellation, and cleanup

### 14.1 Validation and capacity

Validation order is:

1. top-level envelope and structural batch bounds;
2. every selector and NodeId length/parse;
3. requested depth/page limits;
4. response/cursor/concurrency capacity;
5. live session acquisition;
6. OPC UA work.

No OPC UA call occurs when steps 1–3 fail. Malformed batch items are recorded, but all items are validated before valid items begin live work.

At effective concurrent-operation capacity, fail fast with `server_busy`; do not queue. Cursor replay coalescing counts as the original operation, not one operation per waiter. Cursor capacity rejects without silent eviction.

### 14.2 Deadlines and cancellation

Every operation has the configured deadline. Caller cancellation or deadline stops scheduling new work owned exclusively by that caller, invalidates cursors created/used exclusively by that operation, requests native continuation release for exclusively owned state, and discards that caller's late results. For coalesced cursor replay, cancellation follows section 8.4: shared computation and its current/successor tokens remain valid while at least one waiter remains; only cancellation of the sole remaining waiter invalidates them. Cancellation MUST NOT close the shared OPC UA connection solely to cancel read-only work.

If a structured reply remains possible, caller cancellation returns `cancelled` and deadline returns `deadline_exceeded`. Transport-level cancellation MAY prevent delivery, but cleanup requirements still apply.

### 14.3 Retries and reconnect

There is no generic application retry. Allowed recovery is limited to:

- adaptive same-request Read chunk reduction in section 10.3;
- transparent protocol-library recovery that remains within the same connection generation and does not repeat a semantically completed operation.

A reconnect during work fails the request with `connection_changed`, invalidates generation-bound cursors/caches, releases owned native continuation points where the old session permits, and discards late results. Disconnected acquisition fails with `disconnected`.

### 14.4 Logs and metrics

Structured logs/metrics MAY include operation name, duration, generation, item/edge counts, service-call counts, completion/limit reason, normalized error code, cursor lifecycle counts, and cache statistics.

They MUST NOT include values, source text, credentials, endpoint secrets, confirmation/cursor/native-continuation tokens, or raw NodeIds by default. Read-only operations MUST NOT create Control Attempt audit records.

## 15. Control Surface and security invariants

This release does not modify the Control Surface.

- OPC UA Server credentials and roles remain authoritative for reads and underlying Control Operations.
- Read Entry Points remain navigation only.
- Agents still cannot perform arbitrary raw NodeId writes.
- Only Operator-defined Semantic Controls expose Control Operations.
- Discovery or inspection MUST NOT create, enable, alter, or authorize a Control Operation.
- Access/writability/executability indicators are informational only.
- EngineeringUnits, EURange, and InstrumentRange MUST NOT become Control Catalog values, Semantic Control validation, or safety limits.
- OPC UA Server text MUST NOT alter tool instructions, authorization, or Control Catalog configuration.
- Existing online validation, cooldown, Control Confirmation, Control Attempt auditing, audit fail-closed behavior, no-queue/no-write-retry behavior, and Write Verification remain unchanged.
- Existing Control Surface contract tests are release regressions, not optional compatibility checks.

## 16. Test architecture and behavior matrix

### 16.1 Test layers

1. **Inspection-module behavior tests:** deterministic read-only adapter, exercising public module behavior without a live Server.
2. **node-opcua adapter-contract tests:** protocol mapping, exact StatusCodes, BrowseNext, batch Read, namespaces, generation, and continuation release.
3. **MCP contract tests:** exact registered inputs, resources, JSON projections, singleton-to-batch delegation, and structured failures.
4. **Mandatory in-process integration tests:** deterministic node-opcua Server in CI.
5. **Optional external smoke tests:** gated by endpoint credentials.
6. **Optional live Control Operation tests:** separately gated by explicit enable flag, designated safe Node, and safe value.

Current shallow browse/read tests that assert superseded contracts MUST be replaced rather than duplicated. Existing Control Surface regression coverage MUST remain.

### 16.2 Mandatory behavior matrix

The automated suite MUST cover at least:

| Area             | Required cases                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selectors        | NodeId, Read Entry Point label, unknown label, both/neither, oversized/malformed NodeId, all selectors validated before I/O                              |
| Batches          | empty, oversized, malformed item among valid items, order, duplicates, singleton delegation                                                              |
| Browse graph     | forward/inverse/both, hierarchical/all, filters, repeats/cycles, local URI normalization, remote/unmapped targets at/before max depth                    |
| Browse order     | BFS, stable per-source sort, ordinal/path, native continuation across one source                                                                         |
| Completeness     | complete, page size, response size, every traversal limit, denied branch, failed branch, absence-claim rule                                              |
| Cursors          | opacity, query binding, replay byte equality, same successor, concurrent coalescing, expiry, reconnect, cancellation, capacity, terminal replay, cleanup |
| Qualification    | URI success/failure, namespace-zero, missing index, qualified names, ReferenceType, canonical NodeId and ExpandedNodeId forms                            |
| Inspection       | every fixed field state, exact item aggregation, TypeDefinition absent/duplicate/failure, every convenience-indicator truth-table branch                 |
| Diagnostics      | standard qualified property, vendor lookalike ignored, missing, ambiguous, denied discovery, bounded arrays/text, decoders, exact provenance             |
| Read quality     | Good, Uncertain, Bad, exact item aggregation, timestamps present/absent, exact StatusCode, unusable encoding independent of quality                      |
| Values           | every built-in type/scalar tag, Null identity, non-finite floats, one-dimensional arrays, nested-array rejection, text/element cap, unsupported forms    |
| Batch efficiency | advertised limit, absent limit, minimum service calls, adaptive halving, learned generation limit, reconnect reset, singleton terminal failure           |
| Resources        | exact Read Entry Points body/order/empty/oversized roots/static limits; model-context namespace order, metadata outcomes, response bound, no cursor      |
| Bounds           | legacy depth parse compatibility/bounding warning, every new config minimum/default/cap, cross-field rules, text/array bounds, response degradation      |
| Runtime          | disconnected, generation change, deadline, cancellation, late result discard, server busy, no generic retry                                              |
| Security         | sanitized errors/logs, no values/tokens/raw NodeIds in default logs, no Control Attempt audit, no source-text interpretation                             |
| Controls         | listing, low-risk operation, medium-risk prepare/commit, authorization, cooldown, audit fail-closed, Write Verification unchanged                        |

### 16.3 In-process fixtures

The mandatory in-process node-opcua Server MUST provide vendor-neutral building/HVAC fixtures in two forms:

- **hierarchical:** building, room, and HVAC Nodes connected by explicit hierarchical and non-hierarchical references;
- **sparse/flat:** comparable measurements and metadata without an equipment/serving hierarchy.

Together they MUST include directionality, duplicate/repeated references, cycles, native continuation points, low advertised limits, partial denial/failure, Good/Uncertain/Bad DataValues, standard/missing/ambiguous/oversized/unsupported diagnostic metadata, multiple namespaces, and best-effort NamespaceMetadata.

Control tests use fake/default-safe operations. Real Control Operations remain opt-in and target only Operator-approved simulator/test Nodes.

## 17. Release acceptance

Release acceptance is deterministic and scripted; it is not LLM-scored. All of the following are REQUIRED:

1. The hierarchical workflow locates, inspects, and reads relevant Nodes while citing qualified source evidence.
2. The sparse/flat workflow exposes only actual evidence and does not invent equipment or serving relationships.
3. A complete bounded search with no relevant relationship supports only the bounded statement “unknown/not present in this source scope”; an incomplete or denied search does not support absence.
4. Qualification, quality, timestamps, provenance, input correlation, and completeness survive OPC UA adapter, inspection module, and MCP projection.
5. Batch calls are minimal under effective limits; traversal, cursor memory, arrays, concurrency, deadlines, and responses remain bounded.
6. Cycles do not expand without bound, and every native continuation point is released on every terminal path.
7. Cancellation/reconnect cleanup is prompt and late results cannot contaminate a later generation.
8. All outputs are valid bounded JSON and all source text/error data is sanitized.
9. Existing valid config files still validate; all new strict config rules pass.
10. Existing Control Catalog workflows and safety guarantees behave unchanged.
11. Typecheck, lint, unit, MCP contract, adapter-contract, and mandatory in-process integration suites pass.

There is no fixed latency target or coverage-percentage gate. Failure of any behavior-matrix row is a release blocker.

## 18. Decision traceability

| Source | Decision retained here                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #23    | Destination is an implementation-ready OPC UA-native specification; production implementation and broader OPC UA features are out of scope.                                              |
| #24    | Hierarchical and sparse/flat building/HVAC fixtures, deterministic workflows, and default-safe Control Operation testing. Maintained overlay and NodeId-free assumptions are superseded. |
| #25    | Preserve qualified native evidence; do not infer ownership, conformance, ontology, or safety bounds from hierarchy/names/ranges.                                                         |
| #26    | Overlay authoring/lifecycle requirements are not release scope because no maintained overlay is selected.                                                                                |
| #27    | Adopt a maintained model only if later evidence justifies its cost; NodeId visibility is not a failure.                                                                                  |
| #28    | No semantic-definition packaging, activation, or drift lifecycle in this release.                                                                                                        |
| #29    | Select OPC UA-native discovery/metadata/read tools; allow NodeIds; expose absent meaning honestly; retain Control Catalog.                                                               |
| #30    | Retain fixed generic tools rather than generated tools.                                                                                                                                  |
| #31    | No generated semantic tool contract or lifecycle.                                                                                                                                        |
| #32    | Prioritize trustworthy reference-aware browse, qualified inspection, diagnostics, reliable batch reads, and best-effort model context.                                                   |
| #33    | Deep read-only module, exact seams, outcomes, limits, generation fencing, cursors, caching, safety behavior, tests, and acceptance.                                                      |
| #34    | Consolidate the decisions and close public wire/config ambiguities in this normative specification.                                                                                      |

## 19. Deliberate implementation freedom

The following are implementation choices provided externally visible behavior remains exactly conformant:

- source directory/file decomposition of the inspection module;
- internal immutable/mutable data structures for traversal and cursors;
- cryptographic token generator and in-memory store implementation;
- batching scheduler and namespace-zero lookup tables;
- metrics backend and internal event names;
- protocol-adapter private types;
- test helper/factory organization.

Implementations have no freedom to change public JSON shapes, stable vocabularies, configuration keys/defaults/caps, source-trust semantics, generation/cursor behavior, authorization boundaries, or Control Surface invariants without a new decision.

## 20. Reconsideration criteria

A generated view, maintained Semantic Layer, custom decoder, Companion Specification adapter, search index, or persistent cache may be reconsidered only in a later decision backed by repeatable Agent-task failures that this native slice cannot solve and by an explicit Operator maintenance and safety analysis. Absence of source meaning is not itself permission to invent it.
