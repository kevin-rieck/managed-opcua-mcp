# Semantic approach comparison plan

Plan for [#29 — Compare OPC UA-native, generated, and Operator-authored semantic approaches](https://github.com/kevin-rieck/managed-opcua-mcp/issues/29), arising from the decision in [#27](https://github.com/kevin-rieck/managed-opcua-mcp/issues/27) not to define a Semantic Layer domain model before testing the underlying need.

## Question

What concrete Agent failure cannot be solved using OPC UA metadata, generic browse/read tools, and the existing Control Catalog, and what is the smallest intervention that resolves it?

The Semantic Layer is a hypothesis, not a committed architecture. The comparison must not assume that a persistent graph or a NodeId-free Agent workflow is inherently preferable.

## Decision

Use the **OPC UA-native** approach for the next release.

- Improve Agent access to trustworthy OPC UA metadata through generic discovery and read tools.
- Do not add an ephemeral generated equipment view, persistent Operator overlay, generalized entity graph, or separate semantic-definition lifecycle.
- When equipment relationships or other domain context are absent from the OPC UA Server, report that the context is unavailable rather than inventing or maintaining a second information model.
- Keep the existing Control Catalog and its safety, confirmation, authorization, and audit behavior unchanged.
- NodeIds may remain visible and usable in Agent workflows.

This decision favors the smallest maintained system. A future release may reconsider additional semantic assistance only in response to concrete Agent failures observed in real OPC UA-native use.

## Approaches

Compare these approaches against equivalent hierarchical and sparse/flat OPC UA fixtures:

1. **OPC UA-native:** use source metadata through generic discovery and read tools.
2. **Generated view:** derive an ephemeral equipment-oriented summary from discovery without introducing a maintained semantic model.
3. **Operator overlay:** add only persistent Operator assertions shown to be necessary by failures in the first two approaches.

The existing Control Catalog remains unchanged in every approach.

## Tasks

Use two kinds of task so that the result is not predetermined by intentionally absent source information.

### Source-grounded task

Diagnose an equipment condition using meaning available from OPC UA metadata. This tests whether better MCP tooling or presentation is sufficient.

### Missing-context task

Diagnose “Room 101 is too warm” when the room/equipment relationship is intentionally absent from the sparse source model. This tests the cheapest way to supply irreducible Operator knowledge; it does not assume that the answer is a generalized entity/relationship model.

## Progressive Operator context

For the missing-context task, introduce Operator knowledge in this order and stop when the Agent succeeds:

1. a short Operator-authored context document or MCP resource;
2. targeted annotations on selected Read Entry Points or capabilities;
3. a narrow equipment-to-location mapping; and
4. only if the preceding options fail, a generalized entity/relationship model.

Do not reconstruct the OPC UA browse hierarchy or duplicate source metadata as Operator-authored semantics.

## Agent evaluation

For each fixture and approach, record whether the Agent:

- identifies the correct equipment and relevant readings;
- distinguishes observed facts from inferred relationships;
- reaches the correct diagnosis;
- identifies the existing safe Semantic Control when asked;
- avoids inventing unavailable context; and
- completes with a reasonable number of tool calls and without Operator intervention.

Supplying or seeing a NodeId is not itself a failure. Correctness and practical task difficulty are what matter.

## Operator-cost evaluation

Record:

- facts the Operator must author;
- facts duplicated from OPC UA;
- manual NodeId transcription;
- review and activation steps;
- files requiring maintenance;
- changes required after NodeId, hierarchy, or datatype drift; and
- risk of stale context misleading the Agent.

Prefer the approach with the least maintained information that still satisfies the Agent evaluation.

## Threshold for a persistent overlay

Retain an Operator-maintained overlay only if the comparison demonstrates all of the following:

- OPC UA-native and generated approaches cannot reliably complete the representative task across both fixtures;
- the missing meaning cannot be recovered from trustworthy OPC UA evidence;
- a small Operator assertion resolves that specific failure;
- the assertion remains useful across NodeId and hierarchy changes; and
- maintaining it costs less than handling the Agent failure directly.

If this threshold is not met, remove the generalized Semantic Layer from the proposed next release. If it is met, use the observed minimum assertions—not a standards-derived superset—as the input to later domain modeling, packaging, and lifecycle decisions.

## Outcome against the threshold

A persistent overlay was not retained. Although one plain Operator assertion could supply an absent `serves` relationship, the Operator selected OPC UA-native behavior rather than accepting a new source of maintained context. Missing source meaning therefore remains explicitly unknown.

The generated view was also rejected because it cannot recover relationships absent from trustworthy source evidence and adds another presentation contract without resolving that limitation.

## Non-goals

This comparison does not:

- define a Semantic Layer domain model;
- select a configuration format;
- change Control Catalog safety or audit behavior;
- claim that a Companion Specification, ontology, or graph is required;
- require Agents to avoid NodeIds; or
- implement production semantic functionality.
