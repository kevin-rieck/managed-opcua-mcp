# Next-release OPC UA-native inspection specification

Status: Accepted (independently reviewed 2026-08-13)

Issue: [#34](https://github.com/kevin-rieck/managed-opcua-mcp/issues/34)

Decision sources: [#23](https://github.com/kevin-rieck/managed-opcua-mcp/issues/23), [#24](https://github.com/kevin-rieck/managed-opcua-mcp/issues/24)–[#33](https://github.com/kevin-rieck/managed-opcua-mcp/issues/33)

## 1. Purpose

The next release must let an Agent diagnose equipment through trustworthy, source-grounded OPC UA evidence across both hierarchical and sparse/flat address spaces. It must report uncertainty when the OPC UA Server does not provide enough meaning, rather than inventing equipment identity or relationships.

The release adds a deep, read-only inspection module and evolves the fixed generic MCP surface. It does not add a generated equipment view or a maintained Operator-authored Semantic Layer. The existing Control Catalog and all Control Surface safety behavior remain unchanged.

This document is normative for the next-release inspection work. Where `docs/prd.md` or `docs/plan.md` describes the older shallow browse/read contracts differently, this specification governs the changed read-only surface. Existing control requirements remain governed by those documents and ADRs 0001 and 0002.

## 2. Goals and release outcome

The release is accepted when an Agent can:

1. start from configured Read Entry Points;
2. browse actual forward or inverse OPC UA references with trustworthy qualification and explicit completeness;
3. inspect one or more Nodes and distinguish present, absent, denied, failed, and unsupported metadata;
4. read one or more current values efficiently while preserving quality, timestamps, datatype, order, duplicates, and partial failures;
5. obtain best-effort namespace and model context;
6. cite the source Nodes and references used in a conclusion; and
7. report a relationship as unknown when source evidence is absent or discovery is incomplete.

The release must work against deterministic hierarchical and sparse/flat fixtures without requiring new maintained Operator metadata.

## 3. Product decisions

### 3.1 Selected approach

Use OPC UA-native metadata, references, inspection, and current reads. NodeIds are valid and expected in Agent workflows. Names and descriptions help interpretation but are untrusted source evidence.

Retain:

- one configured OPC UA Server endpoint;
- OPC UA Server authorization as the read and underlying write authorization boundary;
- Read Entry Points as navigation aids, not permissions;
- fixed generic MCP tools;
- the existing Control Catalog and Semantic Controls; and
- existing Control Confirmation, Control Attempt auditing, Write Verification, and online validation behavior.

Do not create or infer:

- an equipment abstraction;
- equipment identity or ownership;
- serving or containment relationships;
- units or boolean polarity not supplied by the source;
- process or safety limits from technical ranges; or
- Control Operations from discovered writability or executability.

### 3.2 Agent workflow

1. Read `opcua://read-entry-points` to obtain configured starting Nodes.
2. Call `browse_node` with a NodeId or Read Entry Point label.
3. Follow returned edge evidence, using direction, reference scope, depth, filters, and continuation as needed.
4. Call `inspect_node` or `inspect_nodes` for qualified identity and fixed metadata.
5. Call `read_node` or `read_nodes` for current values.
6. Use `opcua://model-context` when namespace or model provenance matters.
7. State conclusions with source NodeIds/references and the browse `complete` value.
8. If evidence is absent after a complete bounded search, report `unknown from source`. If discovery is incomplete, denied, failed, or limited, do not claim absence.

### 3.3 Operator impact

No new maintained metadata is required. Operators continue to manage:

- connection credentials and OPC UA Server roles;
- optional Read Entry Points;
- optional lower operational limits under `read`; and
- the unchanged Control Catalog.

Compiled hard caps cannot be raised through configuration. Existing configuration remains valid because all new `read` settings are optional. There is no persistent metadata cache, generated configuration, new safety audit, or Operator semantic-authoring lifecycle.

## 4. Architecture

### 4.1 Module boundaries

Introduce `OpcUaInspectionModule`, a deep read-only module with:

```ts
interface OpcUaInspectionModule {
  browse(request: BrowseRequest, signal?: AbortSignal): Promise<BrowseResult>;
  inspect(request: InspectRequest, signal?: AbortSignal): Promise<InspectResult>;
  read(request: ReadRequest, signal?: AbortSignal): Promise<ReadResult>;
  modelContext(signal?: AbortSignal): Promise<ModelContextResult>;
}
```

The concrete types must encode the normative contracts in this document.

Responsibilities:

| Boundary                      | Owns                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/opcua/` protocol adapter | Session leases, `Browse`/`BrowseNext`, batch `Read`, namespace operations, canonical protocol outcomes, Server operation limits, and release of native continuation points                               |
| inspection module             | Selector resolution, traversal, opaque cursors, inspection planning, qualification, quality classification, value encoding, limits, response accounting, cache policy, and connection-generation fencing |
| `src/mcp/`                    | Thin Zod schemas, MCP registration, and projections to/from inspection contracts                                                                                                                         |
| connection owner              | May implement both read-only and control adapters, but exposes them through separate interfaces                                                                                                          |

The inspection interface exposes no write method and has no dependency on the Control Catalog, Control Confirmation, Control Attempt audit, control-value normalization, or write policy. MCP singleton tools invoke the same batch implementation with one item.

### 4.2 Connection generations

Every live operation captures one `connectionGeneration`. Every successful operation result includes:

```json
{
  "ok": true,
  "observedAt": "2026-08-13T12:00:00.000Z",
  "connectionGeneration": 7
}
```

If the generation changes before completion, the entire request fails with `code: "connection_changed"`. Results from different generations must never be mixed. Reconnect or shutdown clears generation-scoped caches and invalidates related cursors.

### 4.3 Caching

Within one generation, the implementation may cache:

- namespace index-to-URI mappings; and
- standard namespace-zero identities.

Custom Server-authored DataType, TypeDefinition, and ReferenceType names are resolved live unless the implementation has positive evidence that they are stable for the generation.

Do not cache Node attributes, source text, access indicators, diagnostic properties, values, StatusCodes, or timestamps. Do not persist cache entries or carry them across sessions.

## 5. Common public contract

### 5.1 Result semantics

- Request-level `ok: false` means the operation could not run or could not produce a coherent bounded response.
- Request-level `ok: true` means the operation ran, even when individual items or fields are partial or failed.
- Batch item state is `success`, `partial`, or `failed`.
- Fixed metadata field state is `present`, `not_present`, `denied`, `failed`, or `unsupported`.
- `not_present` is valid only when absence was positively established. Incomplete, denied, ambiguous, or failed discovery cannot establish absence.
- Exact OPC UA StatusCodes are retained where available.

A field outcome has this conceptual shape:

```ts
type FieldOutcome<T> =
  | { state: 'present'; value: T; source?: QualifiedNodeIdentity; statusCode?: string }
  | { state: 'not_present'; statusCode?: string }
  | {
      state: 'denied' | 'failed' | 'unsupported';
      code: string;
      message: string;
      statusCode?: string;
    };
```

### 5.2 Qualified identities

Every Node identity retains:

- canonical NodeId text;
- namespace index; and
- a namespace URI field outcome.

QualifiedNames and ReferenceTypes retain their indexed identity plus best-effort namespace URI and resolved name. URI or name resolution failure never discards the indexed identifier.

### 5.3 Selectors and validation

A selector contains exactly one of:

```ts
type NodeSelector = { nodeId: string; label?: never } | { label: string; nodeId?: never };
```

Labels resolve only configured Read Entry Points. Semantic Control names are not native read selectors, and native reads never apply Operator-authored normalization or units.

NodeId input is limited to 4,096 characters and parsed before protocol-adapter use. All batch selectors are validated before any OPC UA call. A malformed or conflicting item becomes a correlated item failure while valid items proceed. Empty or oversized batches and invalid envelopes fail the request.

Continuation requests contain only the token and cannot alter the original query.

### 5.4 Errors

Agent-facing errors use stable snake_case codes, bounded single-line messages, and exact StatusCodes where available. Responses never expose stacks, credentials, endpoint secrets, native continuation points, cursor internals, or unsanitized SDK errors.

Timeout and cancellation are request-level failures with `ok: false` (`operation_timeout` or `operation_cancelled`); no partial page is returned. Cancellation stops new internal work, invalidates related cursors, discards late results, and releases owned native continuation points where possible. It must not close the shared OPC UA connection solely to cancel read-only work.

A continuation token that is unknown, expired, cancelled, already terminal, or bound to another connection generation fails with `ok: false` and `invalid_continuation`; it never restarts the browse. A generation change during active work fails with `connection_changed` as specified in section 4.2.

There is no generic application retry. Allowed transparent recovery is limited to same-generation protocol recovery and safe adaptive reduction after an oversized batch rejection.

## 6. MCP surface

The read-only surface is:

- evolved `browse_node`;
- retained and strengthened `read_node` and `read_nodes`;
- new `inspect_node` and `inspect_nodes`;
- existing `opcua://read-entry-points`; and
- new live `opcua://model-context`.

Identifier-less `browse_node` is removed. Agents obtain starting Nodes from `opcua://read-entry-points`.

All tools are read-only annotations with `openWorldHint: true`. Existing Control Surface tools and resources are unchanged.

## 7. Browse contract

### 7.1 Request

A new browse starts with:

```ts
interface BrowseRequest {
  selector: NodeSelector;
  direction?: 'forward' | 'inverse' | 'both';
  referenceScope?: 'hierarchical' | 'all';
  targetNodeClasses?: NodeClass[];
  depth?: number;
  pageSize?: number;
}
```

Defaults are `direction: "forward"`, `referenceScope: "hierarchical"`, depth 1, and configured page size 100. A continuation request is `{ continuation: string }` only.

Raw browse masks and arbitrary ReferenceType filters are deferred.

### 7.2 Response

Browsing is deterministic breadth-first, edge-oriented traversal—not a deduplicated Node tree. Each edge preserves:

- qualified source identity;
- qualified target identity;
- qualified ReferenceType;
- actual direction;
- target BrowseName, DisplayName, and NodeClass outcomes;
- depth and an edge path from the start;
- whether the target Node was seen previously; and
- whether expanding it would create a cycle.

Repeated edges remain visible. Nodes already expanded for the normalized query and cycles are not expanded indefinitely.

```ts
interface BrowseResult extends LiveResult {
  ok: true;
  start: QualifiedNodeIdentity;
  edges: BrowseEdge[];
  complete: boolean;
  incompleteReasons: string[];
  continuation?: string;
}
```

`complete: true` is allowed only after all references reachable within the requested direction, scope, depth, and filters were successfully exhausted. Pagination, limits, and denied or failed branches require `complete: false` and explicit reasons. Cancellation, timeout, and generation change are request failures under section 5.4 and return no partial page.

### 7.3 Cursors

Cursors are opaque, unpredictable, in-memory, query-bound, and generation-bound. They own traversal state and native continuation points.

- Replaying a valid token returns a byte-equivalent page and the same successor token.
- Replay never advances traversal twice and never silently restarts.
- Cursors expire after the configured TTL.
- Completion, expiry, reconnect, cancellation, shutdown, and terminal error release owned native continuation points.
- Cursor capacity rejects new cursor/page creation; it never silently evicts active cursors.

## 8. Inspection contract

### 8.1 Request and correlation

`inspect_node` accepts one selector. `inspect_nodes` accepts `selectors: NodeSelector[]`. Results preserve input order and duplicates. Each item includes its zero-based `index` and the original selector.

### 8.2 Fixed inspection profile

Every item reports outcomes for:

- canonical qualified identity;
- BrowseName;
- NodeClass;
- localized DisplayName and Description;
- TypeDefinition;
- DataType;
- ValueRank;
- raw AccessLevel and UserAccessLevel plus decoded flags;
- raw Executable and UserExecutable;
- clearly labelled current readable/writable/executable convenience indicators;
- EngineeringUnits;
- EURange;
- InstrumentRange;
- EnumStrings; and
- EnumValues.

Access and executable indicators are current hints, not authorization guarantees. Each operation still relies on its OPC UA response.

Diagnostic properties are resolved only through standard qualified OPC UA property identities and expected relationships. Vendor lookalikes are not substituted. Ambiguous sources produce `ambiguous_source`. Property NodeId and StatusCode provenance are retained.

Decode only standard `EUInformation`, `Range`, and `EnumValueType`. General ExtensionObjects are `unsupported`.

## 9. Read contract

### 9.1 Request and batching

`read_node` accepts one selector. `read_nodes` accepts `selectors: NodeSelector[]`. Results preserve input order and duplicates and include `index` and original selector.

One logical MCP batch uses the fewest OPC UA batch `Read` calls permitted by advertised Server limits. If the Server does not advertise a limit, use the configured effective limit. If it rejects an oversized chunk, reduce the active-generation chunk size and retry safely. Batching must not be implemented as parallel singleton reads.

### 9.2 Per-item outcome

Each item reports qualified identity, datatype, raw encoded value when usable, exact StatusCode, classified quality, `usable`, source timestamp, server timestamp, and independent conversion outcome.

- Good: value available and `usable: true`.
- Uncertain: value available, `usable: true`, and explicitly marked `quality: "uncertain"`.
- Bad: no usable value; retain quality, StatusCode, and timestamps.
- JSON conversion is separate from OPC UA quality. Unsupported representation makes the value unusable without changing the Server quality.

### 9.3 JSON-safe values

Support bounded OPC UA built-in scalars and one-dimensional arrays of supported scalars.

| OPC UA value                                | JSON representation                       |
| ------------------------------------------- | ----------------------------------------- |
| Boolean, safe integer, finite float, String | Native JSON scalar                        |
| Int64/UInt64                                | Tagged object containing a decimal string |
| ByteString                                  | Tagged object containing base64           |
| DateTime                                    | Tagged object containing ISO-8601 UTC     |
| Guid, NodeId, ExpandedNodeId, QualifiedName | Canonical tagged object                   |
| LocalizedText                               | Tagged object with text and locale        |
| `NaN`, positive/negative infinity           | Tagged string value                       |

Matrices, custom structures, general ExtensionObjects, unsupported shapes, and oversized arrays are explicit failures. Values are never lossily stringified or silently truncated.

## 10. Model-context resource

`opcua://model-context` is live and returns:

- `observedAt` and `connectionGeneration`;
- namespace index-to-URI mappings; and
- best-effort NamespaceMetadata model URI, version, and publication date, each with field outcomes.

Missing model metadata does not block operation. When response size is reached, return only complete namespace entries with `complete: false` and `limitReason: "response_size"`. Do not add a model-context cursor.

## 11. Limits and resource accounting

Operator settings may lower defaults but never exceed hard caps.

| Limit                           | Configured default |    Hard cap |
| ------------------------------- | -----------------: | ----------: |
| Default requested browse depth  |                  1 |           — |
| Maximum browse depth            |                  5 |          10 |
| Browse request page size        |                100 |         500 |
| Operator maximum page size      |                500 |         500 |
| Total returned edges            |              2,000 |      10,000 |
| Scanned references              |             10,000 |      50,000 |
| Expanded Nodes                  |              2,000 |      10,000 |
| Browse service calls            |              1,000 |       5,000 |
| Read batch                      |                 50 |         500 |
| Inspection batch                |                 25 |         100 |
| Array elements                  |              1,000 |      10,000 |
| Serialized response             |              1 MiB |       4 MiB |
| Cursor TTL                      |          2 minutes |  15 minutes |
| Active cursors                  |                100 |       1,000 |
| Cursor-store memory             |             64 MiB |     256 MiB |
| Concurrent read-only operations |                 16 |         100 |
| Operation deadline              |         30 seconds | 120 seconds |

Text limits are measured in Unicode scalar values: BrowseName/name components 512, DisplayName 1,024, and Description/free text 4,096. Invalid transport controls and malformed Unicode are sanitized. Clipping and sanitization are reported.

Browse stops before response bounds and returns continuation when resumable. Inspect/read retain a correlated outcome for every input, replacing oversized fields with `response_limit_exceeded`. If correlation-only output cannot fit, fail the request. JSON and individual fields are never cut.

Concurrency exhaustion fails fast with `server_busy`. Same-token cursor retries coalesce. Oversized requests fail before OPC UA work.

## 12. Observability and trust boundaries

Structured logs and metrics may include operation, duration, generation, item/edge counts, service-call count, completion and limit reasons, normalized error code, cursor lifecycle, and cache statistics.

Do not log values, source text, credentials, cursor tokens, or raw NodeIds by default. Read-only operations do not create Control Attempt audit records.

OPC UA Server names and descriptions:

- remain identified as source-provided text;
- are never interpreted as instructions, policy, authorization, or Control Catalog configuration;
- are sanitized and bounded before transport; and
- preserve provenance and qualification.

## 13. Control Surface invariants

The release must not change these invariants:

1. Discovery, inspection, and reads never create, enable, alter, or authorize a Control Operation.
2. Discovered writability or executability is informational only.
3. Engineering or instrument ranges never become Semantic Control validation or safety limits.
4. Source text never changes the Control Catalog.
5. Raw NodeId writes remain unavailable to Agents.
6. OPC UA Server authorization remains authoritative.
7. Control Confirmation, Control Attempt auditing, Write Verification, cooldown, online validation, and existing Control Catalog behavior remain unchanged.
8. Read-only operations never depend on control audit availability and never enter the Control Attempt audit.

## 14. Testing strategy

### 14.1 Test layers

- Most behavior tests cross `OpcUaInspectionModule` using a deterministic read-only adapter.
- Adapter-contract tests verify `node-opcua` mapping, continuation handling, qualification, StatusCodes, and batching.
- MCP tests verify schemas and thin projection.
- Obsolete shallow browse/read tests are replaced, not duplicated.
- Control tests remain separate and prove regression invariants.

### 14.2 Mandatory deterministic server

CI runs an in-process `node-opcua` Server with:

- hierarchical and sparse/flat fixtures;
- forward and inverse references;
- repeated Nodes, repeated edges, and cycles;
- native continuation points and small advertised limits;
- per-node and per-field partial failures and denials;
- Good, Uncertain, and Bad values;
- diagnostic properties that are valid, missing, ambiguous, oversized, and unsupported;
- namespace and NamespaceMetadata fixtures;
- arrays and all supported tagged scalar encodings; and
- reconnect/generation-change scenarios.

External OPC UA Server tests remain optional smoke tests. Live Control Operations remain separately opt-in and safety-gated.

### 14.3 Required behavior matrix

The test matrix covers:

- every field state;
- structural and correlated request failures;
- each effective and hard limit;
- cursor replay, expiry, capacity, cancellation, reconnect, shutdown, and cleanup;
- forward, inverse, both, hierarchical, all-reference, repetition, and cycle traversal;
- complete and every incomplete reason;
- qualification and name-resolution failure;
- Good/Uncertain/Bad quality and every supported/unsupported encoding shape;
- sanitization and response accounting;
- adaptive minimal batch calls;
- operation deadline and concurrency rejection; and
- all Control Surface invariants.

## 15. Release acceptance

Acceptance is scripted and deterministic; an LLM is not the release gate.

The release is ready only when:

1. hierarchical fixtures let a scripted client locate, inspect, and read relevant Nodes while citing source evidence;
2. sparse/flat fixtures expose only relationships actually present;
3. a complete bounded search with no matching relationship supports `unknown from source`;
4. incomplete or denied discovery cannot support an absence claim;
5. qualification, quality, timestamps, provenance, and completeness survive MCP projection;
6. batch reads use minimal permitted service calls and preserve order, duplicates, and partial outcomes;
7. traversal, response size, cursor memory, and concurrency remain bounded;
8. all terminal paths release native continuation points and generation-scoped resources;
9. existing Control Catalog workflows and safety tests pass unchanged; and
10. typecheck, lint, unit, MCP contract, adapter contract, and mandatory in-process integration suites pass.

There is no fixed latency or coverage-percentage gate. Efficiency is accepted through bounded-work and minimal-service-call invariants.

## 16. Migration and compatibility

The read-only MCP contracts are unreleased and may change cleanly.

Required changes from the current implementation:

- remove identifier-less `browse_node`; use `opcua://read-entry-points`;
- change browse output from a shallow/deduplicated Node list to qualified edges with completeness and continuation;
- stop resolving Semantic Control names in native read tools;
- stop applying Semantic Control labels, units, or normalization to native reads;
- make `read_nodes` use true OPC UA batch reads rather than singleton calls;
- add fixed inspection tools and model-context resource;
- add optional inspection/browse/read/cursor/response/concurrency/deadline settings under `read`;
- split the current broad gateway so the inspection module depends only on a read-only protocol seam; and
- replace conflicting shallow-contract tests and update `docs/prd.md`, `docs/plan.md`, README, and Operator documentation during implementation.

Existing valid configuration remains valid. Existing Control Surface inputs, outputs, and behavior are not intentionally changed.

## 17. Explicit non-goals

This release does not include:

- generated equipment views or generated MCP tools;
- a maintained Operator-authored Semantic Layer;
- inferred domain relationships, equipment identity, ownership, units, polarity, or process meaning;
- semantic-definition packaging, activation, composition, or drift workflows;
- full-text/fuzzy search or maintained indexes;
- arbitrary AttributeId reads;
- historical reads, subscriptions, monitored items, events, or alarms;
- method calls or raw writes outside the Control Catalog;
- custom-structure, general ExtensionObject, or matrix decoding;
- multiple OPC UA endpoints;
- Companion Specification-specific adapters or ontology mapping;
- persistent or cross-session metadata caching;
- a graphical editor or hosted management service; or
- weakening any existing Control Surface safety invariant.

## 18. Traceability

| Source | Resolution carried into this specification                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #24    | Retain representative hierarchical and sparse/flat building/HVAC scenarios and safety boundaries; reject its later-superseded maintained-layer assumptions     |
| #25    | Preserve qualified source evidence; avoid hierarchy inference, mandatory ontologies, model cloning, automatic activation, and technical-range safety inference |
| #26    | Retain safety lessons, but do not introduce an Operator authoring/maintenance lifecycle                                                                        |
| #27    | Test OPC UA-native capabilities before adding a Semantic Layer; NodeId visibility is not a failure                                                             |
| #28    | No semantic-definition packaging or composition in this release                                                                                                |
| #29    | Select OPC UA-native tools; reject generated views and maintained overlays; expose missing meaning as unknown                                                  |
| #30    | Keep fixed generic tools; do not generate MCP tools                                                                                                            |
| #31    | No semantic activation/drift lifecycle; existing Control Catalog behavior remains                                                                              |
| #32    | Feature priorities, trust semantics, Agent/Operator outcomes, and deferrals                                                                                    |
| #33    | Architecture, contracts, limits, failure behavior, test strategy, and acceptance                                                                               |

Implementation may choose internal names and file placement consistent with these boundaries, but it must not alter public semantics, safety boundaries, limits, or acceptance criteria without a new recorded decision.
