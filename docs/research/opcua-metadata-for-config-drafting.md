# OPC UA metadata useful for config drafting

Research for [Research OPC UA metadata useful for config drafting](https://github.com/kevin-rieck/managed-opcua-mcp/issues/4).

## Question

What OPC UA metadata can the MCP Server reliably read with configured credentials to help draft Read Entry Points and Semantic Controls, including data types, access levels, engineering units, ranges, display names, descriptions, and writable status?

## Sources

- `node_modules/node-opcua-client/dist/client_session.d.ts` — `ClientSession` exposes `browse()`, `browseNext()`, and `read()` services.
- `node_modules/node-opcua-basic-types/dist/attributeIds.d.ts` — OPC UA AttributeIds exported by `node-opcua`.
- `node_modules/node-opcua-service-browse/source/index.ts` — browse result mask and `ReferenceDescription` field documentation.
- `node_modules/node-opcua-types/dist/_generated_opcua_types.d.ts` — generated browse/reference structures used by `node-opcua`.
- `node_modules/node-opcua-data-model/dist/access_level.d.ts` — `AccessLevelFlag` bit meanings.
- `node_modules/node-opcua-address-space/dist/src/namespace_impl.js` — comments and implementation for `EURange`, `InstrumentRange`, `EngineeringUnits`, `EnumStrings`, and `EnumValues` properties, including embedded OPC UA Part 3 / Part 8 references.
- `node_modules/node-opcua-address-space/dist/source/interfaces/data_access/ua_multistate_discrete_ex.d.ts` and `ua_multistate_value_discrete_ex.d.ts` — Data Access discrete item metadata behavior and OPC Foundation reference links.
- Current repo gateway: `src/opcua/gateway.ts`, `src/opcua/node-opcua-gateway.ts`, `src/mcp/online-validation.ts`.

## Findings

### 1. Browsing reliably yields identity and structural metadata

`node-opcua` exposes `ClientSession.browse()` and `browseNext()` for address-space navigation. Browse responses contain `ReferenceDescription` entries. The browse result mask fields documented by `node-opcua` are:

- ReferenceType
- IsForward
- NodeClass
- BrowseName
- DisplayName
- TypeDefinition

`ReferenceDescription` includes `referenceTypeId`, `isForward`, target `nodeId`, `browseName`, `displayName`, `nodeClass`, and `typeDefinition`.

**Implication:** discovery can reliably collect NodeId, browse name, display name, node class, reference type, direction, and type definition for browsed children, subject to the server returning them and the configured session being allowed to browse.

### 2. Description, data type, access flags, and method executability are OPC UA attributes read by NodeId

`node-opcua` exports these AttributeIds:

- `NodeId` = 1
- `NodeClass` = 2
- `BrowseName` = 3
- `DisplayName` = 4
- `Description` = 5
- `Value` = 13
- `DataType` = 14
- `ValueRank` = 15
- `ArrayDimensions` = 16
- `AccessLevel` = 17
- `UserAccessLevel` = 18
- `Executable` = 21
- `UserExecutable` = 22
- `DataTypeDefinition` = 23
- `RolePermissions` = 24
- `UserRolePermissions` = 25
- `AccessRestrictions` = 26
- `AccessLevelEx` = 27

`ClientSession.read()` can read arbitrary attributes by passing a NodeId and AttributeId.

**Implication:** discovery should read attributes rather than live `Value` when it needs metadata. For Variables, useful reads are `Description`, `DataType`, `ValueRank`, `ArrayDimensions`, `AccessLevel`, `UserAccessLevel`, and optionally `AccessLevelEx`. For Methods, useful reads are `Executable` and `UserExecutable`.

### 3. Writable status should be based on UserAccessLevel, not AccessLevel alone

`AccessLevelFlag` defines bit flags including:

- `CurrentRead` = 1
- `CurrentWrite` = 2
- `HistoryRead` = 4
- `HistoryWrite` = 8
- `SemanticChange` = 16
- `StatusWrite` = 32
- `TimestampWrite` = 64

`AccessLevel` describes the Node's general access capabilities. `UserAccessLevel` is the access level for the current session/user.

**Implication:** for config drafting with configured credentials, use `UserAccessLevel.CurrentRead` and `UserAccessLevel.CurrentWrite` as the best available metadata signal for readable/writable status. `AccessLevel` is still useful context, but `UserAccessLevel` is closer to what the MCP Server can do with its configured session. Treat access metadata as advisory: actual reads/writes may still fail and must remain subject to OPC UA Server authorization.

### 4. Data type can be collected, but supported control eligibility still needs filtering

For Variables, `DataType` is an attribute. The current v1 plan supports Semantic Control writes only for these OPC UA built-in data types: `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String`.

`ValueRank` and `ArrayDimensions` indicate scalar vs array/structured shapes. Current v1 out of scope excludes complex values such as arrays, ExtensionObjects, and structures.

**Implication:** discovery can collect `DataType`, `ValueRank`, and `ArrayDimensions`, but should only suggest draft Semantic Control candidates for scalar Variables whose datatype maps to the v1 supported set. Other readable/writable Variables should be reported as discovered but not suggested, with reasons such as unsupported datatype, array value rank, or missing datatype metadata.

### 5. Engineering units and ranges are Data Access Properties, not universal attributes

`node-opcua` Data Access implementation creates standard Property children:

- `EURange`: Range; defines the value range likely to be obtained in normal operation and is used for display scaling. The embedded Part 8 comment warns that servers may accept/reject/clamp writes outside this range in a server-dependent way.
- `InstrumentRange`: optional Range; created as a Property when configured.
- `EngineeringUnits`: optional EUInformation; specifies the units for a DataItem's value.

These appear as child Properties, not as attributes on every Variable.

**Implication:** discovery can find engineering unit/range metadata by browsing or translating/browsing child Properties named `EngineeringUnits`, `EURange`, and `InstrumentRange`, then reading their `Value` attributes. This metadata is useful for draft suggestions, but absence is normal. `EURange` should not automatically become a Semantic Control process min/max without Operator confirmation, because the source comment says behavior outside the range is server-dependent and the range is intended for normal operation/display scaling.

### 6. Enum labels may be available through EnumStrings/EnumValues, but not for arbitrary strings

`node-opcua` Data Access and namespace implementation documents:

- `EnumStrings`: `LocalizedText[]`; applies to Enumeration DataTypes where integer values map by array position.
- `EnumValues`: `EnumValueType[]`; supports sparse/non-zero-based integer enumerations with value, display name, and description.

The MultiStateValueDiscrete interfaces note that clients often read `EnumValues` in advance and cache it to map numeric values to names/help.

**Implication:** discovery can read `EnumStrings`/`EnumValues` when present and use them to propose ordered allowed values for enum-like numeric controls. It should not infer allowed values for arbitrary `String` controls unless a standard or vendor-specific metadata source is explicitly identified and trusted. Current live values are not sufficient to infer allowed sets.

### 7. Display names and descriptions are useful but not sufficient for safety fields

Browse returns `displayName`; attributes can read `Description`. These are useful as suggested labels/descriptions for Read Entry Points and draft Semantic Controls.

**Implication:** discovery may propose human-readable names/descriptions, but Operator review remains required. Risk Level, Risk Note, process validation constraints, boolean polarity labels, and promotion into executable `controls.items` cannot be reliably inferred from OPC UA metadata alone.

### 8. Existing gateway is currently too thin for this discovery workflow

Current `OpcUaGateway` exposes browse/read/write and a minimal `getNodeMetadata()` that infers existence/browseability/readability by attempting browse/read value operations. The `node-opcua` gateway currently reads only AttributeId 13 (`Value`) and browse ReferenceDescription fields. It does not yet expose generic attribute reads, UserAccessLevel, ValueRank, Description, EngineeringUnits, ranges, or enum metadata.

**Implication:** setup/commissioning discovery should probably add a new gateway method rather than overload live reads. A suitable seam might expose `browseMetadata()` and `readAttributes()` or a higher-level `discover()` API that returns structured metadata and per-field status codes.

## Reliability matrix

| Metadata | How to get it | Reliability for config drafting | Use in generated draft |
| --- | --- | --- | --- |
| NodeId | Browse `ReferenceDescription.nodeId`; can also read NodeId attribute | High when browse succeeds | Yes |
| BrowseName | Browse result or BrowseName attribute | High when browse/read succeeds | Suggested labels/path |
| DisplayName | Browse result or DisplayName attribute | High when provided | Suggested labels/descriptions |
| Description | Description attribute | Medium; often absent | Suggested description only |
| NodeClass | Browse result or NodeClass attribute | High | Classify Object/Variable/Method |
| TypeDefinition | Browse result | Medium-high | Explain likely Data Access/discrete/analog type |
| DataType | Variable `DataType` attribute | High for Variables when readable | Filter supported control candidates |
| ValueRank / ArrayDimensions | Variable attributes | High when readable | Reject arrays/complex shapes for v1 controls |
| AccessLevel | Variable attribute | Medium; general capability, not session-specific | Context only |
| UserAccessLevel | Variable attribute | Higher for configured session | Best metadata signal for readable/writable candidate status |
| Executable | Method attribute | Medium; general capability | Report only; method calls out of scope |
| UserExecutable | Method attribute | Higher for configured session | Report only; method calls out of scope |
| EngineeringUnits | Data Access Property value | Medium; optional | Suggested unit, Operator-confirmed |
| EURange | Data Access Property value | Medium; optional and not a hard write bound | Suggested normal range, Operator-confirmed |
| InstrumentRange | Data Access Property value | Medium; optional | Suggested range context, Operator-confirmed |
| EnumStrings | Enumeration Property value | Medium; only when modelled | Draft enum labels for Operator review |
| EnumValues | Enumeration/MultiState Property value | Medium; only when modelled | Draft enum allowed values for Operator review |
| Current Value | Value attribute | Technically readable but intentionally avoided | Not used by default |

## Recommended discovery behavior

1. Browse forward hierarchical references using continuation points where needed.
2. For each visited Node, record browse result fields and per-node browse status.
3. Batch-read metadata attributes by Node class:
   - all Nodes: `Description` where useful
   - Variables: `DataType`, `ValueRank`, `ArrayDimensions`, `AccessLevel`, `UserAccessLevel`, optionally `AccessLevelEx`
   - Methods: `Executable`, `UserExecutable`
4. For Variables that look like Data Access items, browse/read child Properties named `EngineeringUnits`, `EURange`, `InstrumentRange`, `EnumStrings`, and `EnumValues`.
5. Carry per-field status codes/errors into the commissioning report instead of failing the whole discovery.
6. Suggest Read Entry Points from explicit roots/high-level folders and readable branches.
7. Suggest draft Semantic Control candidates only for scalar Variables with supported datatypes, `UserAccessLevel.CurrentWrite`, and enough naming context.
8. Never use metadata to bypass OPC UA authorization. Treat it as commissioning evidence; runtime reads/writes must still handle structured OPC UA rejections.

## Open follow-up questions

- Whether discovery should use a generic `readAttributes()` gateway method or a purpose-built `discover()` method.
- Whether `AccessLevelEx` should matter for v1 control candidates or only be reported.
- How to present absent-but-optional Data Access metadata without alarming Operators.
- How much vendor-specific metadata support, if any, belongs in later versions.
