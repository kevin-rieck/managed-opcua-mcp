# Industrial semantic patterns for the next-generation Semantic Layer

Research for [#25 — Research reusable industrial semantic standards](https://github.com/kevin-rieck/managed-opcua-mcp/issues/25).

## Question

Which concepts and patterns from OPC UA information models, Companion Specifications, and other directly relevant industrial semantic standards should the MCP Server reuse or deliberately avoid when defining its Semantic Layer?

## Sources and method

This review uses primary, versioned sources:

- OPC UA Part 3, Address Space Model v1.05.06:
  - [Object Model, §4.3](https://reference.opcfoundation.org/Core/Part3/v105/docs/4.3)
  - [References, §4.4.4](https://reference.opcfoundation.org/Core/Part3/v105/docs/4.4.4)
  - [TypeDefinitionNodes, §4.6.1](https://reference.opcfoundation.org/Core/Part3/v105/docs/4.6.1)
  - [HierarchicalReferences, §7.3](https://reference.opcfoundation.org/Core/Part3/v105/docs/7.3)
  - [HasComponent, §7.7](https://reference.opcfoundation.org/Core/Part3/v105/docs/7.7)
  - [HasProperty, §7.8](https://reference.opcfoundation.org/Core/Part3/v105/docs/7.8)
  - [Organizes, §7.11](https://reference.opcfoundation.org/Core/Part3/v105/docs/7.11)
  - [NodeId, §8.2](https://reference.opcfoundation.org/Core/Part3/v105/docs/8.2)
  - [Base NodeClass attributes, §5.2](https://reference.opcfoundation.org/Core/Part3/v105/docs/5.2)
- OPC UA Part 8, Data Access v1.05:
  - [Data Access model, §5.3](https://reference.opcfoundation.org/Core/Part8/v105/docs/5.3)
  - [EUInformation, §5.6.4](https://reference.opcfoundation.org/Core/Part8/v105/docs/5.6.4)
- OPC UA for Devices (DI) v1.05:
  - [TopologyElementType, §4.3](https://reference.opcfoundation.org/DI/v105/docs/4.3)
  - [FunctionalGroupType, §4.4.1](https://reference.opcfoundation.org/DI/v105/docs/4.4.1)
  - [TagNameplate Interface, §4.5.3](https://reference.opcfoundation.org/DI/v105/docs/4.5.3)
- OPC UA for Machinery v1.04:
  - [Use cases, §5](https://reference.opcfoundation.org/Machinery/v104/docs/5)
  - [MachineryItemIdentificationType, §8.3](https://reference.opcfoundation.org/Machinery/v104/docs/8.3)
  - [MachineComponentsType, §11.2](https://reference.opcfoundation.org/Machinery/v104/docs/11.2)
- OPC Foundation's official [UA-Nodeset repository at commit `b877ed8`](https://github.com/OPCFoundation/UA-Nodeset/tree/b877ed8aa3d42f981d5e8744469acefcfc68cddc), used to verify standard Node/type names and published Companion Specification NodeSets.
- IDTA Asset Administration Shell (AAS) metamodel at commit [`749fe4e`](https://github.com/admin-shell-io/aas-specs-metamodel/tree/749fe4eb5220e6c04b942ae736fb9020efa2df87):
  - [AAS concepts](https://github.com/admin-shell-io/aas-specs-metamodel/blob/749fe4eb5220e6c04b942ae736fb9020efa2df87/documentation/IDTA-01001/modules/ROOT/pages/annex/concepts-aas.adoc)
  - [ConceptDescription](https://github.com/admin-shell-io/aas-specs-metamodel/blob/749fe4eb5220e6c04b942ae736fb9020efa2df87/documentation/IDTA-01001/modules/ROOT/pages/spec-metamodel/concept-description.adoc)
  - [Submodel elements](https://github.com/admin-shell-io/aas-specs-metamodel/blob/749fe4eb5220e6c04b942ae736fb9020efa2df87/documentation/IDTA-01001/modules/ROOT/pages/spec-metamodel/submodel-elements.adoc)

The findings distinguish patterns worth reusing from standards that the MCP Server should claim to implement. Reusing a pattern does not imply OPC UA Companion Specification or AAS conformance.

## Findings

### 1. Reuse a graph of identified entities and typed, directed relationships

OPC UA represents Objects in terms of Variables and Methods, connected through typed References. A Reference is identified by source Node, ReferenceType, and target Node; its target may even reside in another Server. AAS similarly provides `RelationshipElement`, whose meaning is supplied by a semantic identifier and whose endpoints may be internal model references or external references.

**Recommendation:** represent the Semantic Layer as:

- stable semantic entities;
- typed, directed relationships between entities; and
- capabilities attached to entities or reached through relationships.

Each relationship needs a stable type/name, source entity, target entity, and human-readable description. It should optionally carry an external semantic reference URI and provenance.

This supports the accepted fixture directly: `building_1 contains room_101` and `ac_1 serves room_101`, even where no corresponding source Nodes or OPC UA References exist.

### 2. Keep semantic identity separate from OPC UA binding identity

OPC UA Part 3 says a NodeId identifies a Node within a Server. It also says a Server may change a NodeId's numeric namespace index between sessions; clients must not assume the index remains unchanged. The associated namespace URI identifies the naming authority. BrowseName is explicitly not an unambiguous Node identifier and should not be used as a display name.

DI's `AssetId` is an integrator/user-provided identifier, while Machinery distinguishes human-readable manufacturer/model information from globally unique or machine-readable identification fields. AAS likewise separates globally identified model concepts from short, human-facing names.

**Recommendation:** give each semantic entity and capability an Operator-controlled stable ID that is independent of:

- NodeId;
- BrowseName;
- DisplayName;
- browse path; and
- current Server hierarchy.

Store NodeId as binding/provenance, not as semantic identity. Binding evidence should retain the namespace URI plus identifier where available, because `ns=<index>` alone is vulnerable to namespace-table drift. Labels and descriptions remain presentation metadata and are not identifiers.

### 3. Reuse OPC UA type and namespace evidence; do not infer conformance from names

OPC UA TypeDefinitionNodes define common characteristics for instances. Part 3 notes that standards organizations can publish well-known TypeDefinitionNodes so clients can interpret instances consistently across Servers. The UA-Nodeset repository publishes the normative machine-readable NodeSets for Core and Companion Specifications.

**Recommendation:** discovery should retain, when available:

- TypeDefinition NodeId and namespace URI;
- BrowseName as a qualified name, including its namespace;
- ReferenceType and direction;
- DataType and value shape; and
- namespace/model metadata sufficient to identify an installed Companion Specification.

A known namespace plus known TypeDefinition can support a high-confidence draft hint. Matching only a local BrowseName such as `Temperature`, `State`, or `Identification` cannot justify a standards-conformance claim or automatic semantic assignment.

### 4. Reuse a small template/instance distinction without cloning OPC UA's type system

OPC UA ObjectTypes and VariableTypes define reusable instance declarations and mandatory/optional modelling rules. AAS separates templates from instances and uses submodels to compose concerns. Both demonstrate the value of reusable definitions that can be bound repeatedly to concrete equipment.

**Recommendation:** allow reusable semantic equipment/capability templates and concrete instances, but keep the initial model shallow:

- a template defines expected semantic capabilities and relationships;
- an instance has its own semantic identity and concrete OPC UA bindings;
- required versus optional template members are explicit; and
- instance-specific overrides are narrow and visible.

Do not reproduce OPC UA inheritance, AddIns, Interfaces, placeholder modelling rules, or the full AAS metamodel in YAML. Those systems solve broader information-model exchange and digital-twin problems than this MCP Server needs.

### 5. Reuse functional grouping as Agent navigation, not as identity

DI `FunctionalGroupType` organizes Properties, Parameters, and Methods by application concern such as configuration, diagnostics, asset management, and condition monitoring. A Node may appear in more than one FunctionalGroup, groups may nest, and groups can be hidden depending on state. Machinery similarly calls for monitoring information such as state, health, process, and consumption to be easy to access.

**Recommendation:** let an entity's capabilities carry one or more small Agent-facing groups/aspects, such as:

- `status`;
- `measurements`;
- `energy`;
- `setpoints`; and
- `controls`.

Groups are navigation facets, not ownership, unique identity, or authorization boundaries. Do not assume a source Folder or DI FunctionalGroup maps one-to-one to a semantic entity.

### 6. Preserve standard data semantics and provenance, but require Operator confirmation for safety policy

OPC UA Data Access defines standard metadata:

- `EngineeringUnits` uses `EUInformation`, including a namespace URI for the unit system, programmatic unit ID, display name, and description;
- `InstrumentRange` is the range an instrument can return;
- `EURange` is the range likely in normal operation and is intended for uses such as display scaling;
- writes outside `EURange` are explicitly Server-dependent (accept, reject, clamp, or other behavior); and
- enum/discrete VariableTypes provide standard value-label metadata.

Part 8 intentionally supports multiple unit systems rather than defining a new universal one; its default mapping uses UN/CEFACT and identifies the unit system by URI.

**Recommendation:** retain discovered unit identifiers, labels, ranges, enum labels, source status, and source location as evidence. Normalize them for Agent presentation only when the conversion is explicit and lossless. Never silently turn:

- `EURange` into a Semantic Control bound;
- `InstrumentRange` into a safe process limit;
- an enum label into a safety interpretation; or
- current access metadata into an authorization guarantee.

Operator-confirmed process constraints, boolean polarity, Risk Level, and Risk Note remain distinct from discovered technical metadata.

### 7. Support optional external semantic references; do not require an ontology

AAS uses semantic IDs and ConceptDescriptions to connect model elements to external definitions. Its `ConceptDescription.isCaseOf` can record compatibility with or derivation from an external definition. OPC UA 1.05 also publishes dictionary-related types and `HasDictionaryEntry` in the official Core NodeSet.

**Recommendation:** permit optional URI-based semantic references on entity types, relationship types, and capabilities. Record whether a reference was:

- asserted by the source OPC UA model;
- suggested by discovery; or
- assigned by the Operator.

The MCP Server should treat these references as descriptive/provenance data in the next release, not perform ontology reasoning or dereference remote vocabularies at runtime. A definition without external semantic references must remain valid; sparse proprietary Servers are a primary success case.

### 8. Preserve explicit provenance and confidence; source and Operator assertions are not interchangeable

The accepted scenario requires the Operator to add `room_101` and `serves`, which are absent from the source Server. Other fields may come from Node attributes, Data Access Properties, Companion Specification types, or Operator decisions. AAS's distinction between semantic references and concept definitions, and OPC UA's qualified namespaces and type evidence, both reinforce the need to retain where meaning came from.

**Recommendation:** every generated or imported binding/semantic suggestion should identify its source and review state. At minimum distinguish:

- observed OPC UA evidence;
- inference based on a known standard model;
- generated naming suggestion; and
- Operator assertion.

Confidence can rank suggestions for review, but cannot activate them or replace explicit Operator decisions.

## Patterns to avoid deliberately

| Avoid | Reason |
| --- | --- |
| Treating the OPC UA browse hierarchy as the semantic equipment hierarchy | `HierarchicalReferences` may contain loops; `Organizes` is organizational; and source models may be flat or incomplete. |
| Treating `HasComponent` as lifecycle ownership | Part 3 says it represents part-of semantics but does not specify ownership or deletion behavior. |
| Using BrowseName, DisplayName, browse path, or NodeId as cross-Server semantic identity | BrowseName is non-unique, DisplayName is presentation text, paths/hierarchies vary, and NodeId identifies a Node within a Server. |
| Inferring Companion Specification conformance from familiar names | Reliable reuse requires namespace and type/model evidence. |
| Copying the full OPC UA type system or AAS metamodel into configuration | It would make authoring deep and brittle while duplicating standards whose full exchange/lifecycle semantics the MCP Server does not implement. |
| Requiring Companion Specifications, dictionaries, or external ontologies | The primary target is a sparse proprietary Server. Standards evidence is optional enrichment. |
| Runtime ontology lookup or reasoning | It adds network dependence, trust/version ambiguity, and failure modes without being necessary for the accepted Agent workflow. |
| Automatically activating generated semantics | The Operator remains authoritative; suggestions and source metadata are evidence only. |
| Converting technical ranges into safe Control Surface constraints | OPC UA explicitly gives `EURange` different semantics and Server-dependent out-of-range write behavior. |
| Inventing another unit vocabulary | Preserve standard unit-system URI and unit ID where provided; add display normalization explicitly. |
| Replacing OPC UA Server authorization with semantic relationships or groups | Semantic structure and navigation do not grant read/write rights. |
| Claiming AAS or Companion Specification conformance from pattern reuse | Conformance requires implementing each standard's normative model and rules, which is not the goal. |

## Recommended minimum standards-aware model

The next domain-model ticket should be able to express, without adopting a full external metamodel:

```text
SemanticDefinition
  ├─ semantic entities (stable Operator-controlled IDs, type, label, description)
  ├─ typed directed relationships (source, type, target)
  ├─ capabilities (read or Semantic Control, attached to an entity)
  ├─ optional templates instantiated by entities
  ├─ optional groups/aspects for Agent navigation
  └─ provenance
       ├─ OPC UA binding (NodeId plus namespace/type/reference evidence)
       ├─ optional external semantic URI
       ├─ assertion source
       └─ review state
```

This is deliberately a projection over OPC UA, not a replacement information model. It can preserve and reuse strong source semantics when present while allowing the Operator to supply missing equipment identity and relationships.

## Consequences for subsequent tickets

- **#27 domain model:** define stable semantic IDs, entity/template distinction, typed relationships, capabilities, bindings, and provenance. Keep external semantic URIs optional.
- **#28 packaging:** separate reusable templates from deployment-specific instances/bindings; record definition and source-model versions without adopting NodeSet XML as the authoring format.
- **#29 prototype:** show both source-derived and Operator-authored semantics, especially `room_101` and `serves`; make provenance inspectable.
- **#30 MCP tools:** organize Agent discovery around entities, relationships, capabilities, and optional groups—not source folders.
- **#31 validation/drift:** validate namespace URI, Node identity, type/value shape, and standards evidence; treat namespace-index changes differently from true target drift.
- **#32 prioritization:** defer ontology reasoning, remote dictionary resolution, full Companion Specification import, full AAS interchange, and automatic unit conversion unless a later success scenario requires them.
