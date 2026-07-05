# PRD: OPC UA MCP Server

## Problem Statement

Agents need a safe way to inspect and operate an OPC UA Server. Directly exposing OPC UA access to agents is too broad: an OPC UA address space may contain sensitive read data, production-critical writable Nodes, vendor internals, and operations that could affect equipment or availability.

Operators need an MCP Server that lets Agents browse and read only approved areas, and perform only Operator-approved Semantic Controls with explicit validation, risk communication, auditability, and failure-safe behavior.

## Solution

Build a TypeScript/Node.js MCP Server that connects to one configured OPC UA Server endpoint over a persistent OPC UA session and exposes:

- scoped browse/read tools over a configured Read Scope
- minimal status/config/read-scope resources
- Semantic Controls for Operator-approved writes
- Control Confirmation for medium-risk Semantic Controls
- append-only audit logging for all Control Attempts
- strict YAML configuration with no literal secrets
- local stdio operation for v1

The MCP Server will favor safety, auditability, and Operator intent over generic OPC UA power. It will not expose arbitrary writes. Agents will use Semantic Control names rather than raw writable NodeIds.

## User Stories

1. As an Agent, I want to inspect the MCP Server status, so that I know whether the OPC UA Server is connected.
2. As an Agent, I want status to distinguish disconnected, reconnecting, online-validation-pending, and online-validation-failed states, so that I can respond appropriately.
3. As an Agent, I want sanitized error summaries, so that I get useful operational feedback without seeing sensitive internals.
4. As an Agent, I want to see the configured Read Scope roots, so that I know where browsing can begin.
5. As an Agent, I want to browse configured Read Scope roots without knowing a starting NodeId, so that discovery is easy.
6. As an Agent, I want to browse a readable Node by NodeId, so that I can inspect the configured OPC UA address space.
7. As an Agent, I want to browse a readable Node by configured label, so that I can use stable human-readable names.
8. As an Agent, I want browse results to include NodeIds, browse names, display names, node classes, data types, and capability flags, so that I can understand what each Node represents.
9. As an Agent, I want browse results to omit current values, so that browsing remains cheap and structural.
10. As an Agent, I want browse depth to be bounded, so that I do not accidentally traverse a huge address space.
11. As an Agent, I want to read one Node by NodeId, so that I can inspect a specific current value.
12. As an Agent, I want to read one Node by configured label, so that I can avoid remembering NodeIds for common values.
13. As an Agent, I want to read multiple Nodes in one call, so that I can collect a coherent snapshot efficiently.
14. As an Agent, I want batch reads to return per-node results, so that one bad Node does not hide successful reads.
15. As an Agent, I want read results to include OPC UA status codes and timestamps, so that I can judge data freshness and quality.
16. As an Agent, I want enum-like values to be normalized to configured labels when mappings exist, so that I can reason in domain language.
17. As an Agent, I want raw values included with normalized labels, so that results remain traceable to OPC UA values.
18. As an Agent, I want reads outside the Read Scope to be rejected as structured results, so that I can understand policy boundaries.
19. As an Agent, I want to list Semantic Controls, so that I know what Control Operations are available.
20. As an Agent, I want `list_controls()` to show unavailable Semantic Controls with machine-readable reasons, so that I can explain why a control cannot run.
21. As an Agent, I want Semantic Controls to include descriptions, Risk Levels, Risk Notes, value constraints, units, cooldowns, and confirmation requirements, so that I can choose controls safely.
22. As an Agent, I want Semantic Control NodeIds visible for troubleshooting, so that I can correlate controls with read metadata.
23. As an Agent, I want current values omitted from `list_controls()`, so that listing controls remains cheap and policy-focused.
24. As an Agent, I want low-risk Semantic Controls to be executable with one tool call, so that harmless or simulation-safe operations stay simple.
25. As an Agent, I want low-risk control writes to accept an optional reason, so that I can improve the audit trail when useful.
26. As an Agent, I want medium-risk Semantic Controls to require prepare/commit Control Confirmation, so that risky operations are deliberate.
27. As an Agent, I want `prepare_control` to return the Risk Note, requested value, current value when readable, expiry, and commit availability, so that I can review the action before committing.
28. As an Agent, I want `commit_control` to accept only an opaque token, so that the prepared action cannot be accidentally changed.
29. As an Agent, I want expired, stale, or invalid confirmation tokens to be rejected with structured reasons, so that I can prepare again safely.
30. As an Agent, I want medium-risk controls to require a reason, so that the audit trail records intent.
31. As an Agent, I want write results to include requested values, raw values, OPC UA status, verification results, and audit IDs, so that I know what happened.
32. As an Agent, I want write accepted-but-verification-failed to be distinct from success and failure, so that I do not assume the intended state was reached.
33. As an Agent, I want expected domain rejections returned as structured tool responses, so that I can reason over them programmatically.
34. As an Agent, I want MCP protocol errors reserved for malformed arguments and server bugs, so that operational failures remain data.
35. As an Operator, I want to define Read Scopes in YAML, so that Agents only inspect approved portions of the OPC UA address space.
36. As an Operator, I want roots, explicit readable Nodes, and exclusions, so that I can express practical read boundaries.
37. As an Operator, I want exact and subtree exclusions, so that I can hide sensitive or noisy areas.
38. As an Operator, I want optional labels and descriptions for read roots and explicit read Nodes, so that Agents get understandable entry points.
39. As an Operator, I want explicit read-node value mappings, so that important read-only values can use labels and units.
40. As an Operator, I want to define Semantic Controls in YAML, so that Control Operations are explicit, reviewable, and versionable.
41. As an Operator, I want each Semantic Control to have a stable snake_case name, so that Agents and logs use predictable identifiers.
42. As an Operator, I want each Semantic Control to include a description, so that Agents understand its purpose.
43. As an Operator, I want each Semantic Control to include a Risk Level and Risk Note, so that risk is explicit and contextual.
44. As an Operator, I want high-risk Semantic Controls rejected in v1, so that the first version cannot expose dangerous operations.
45. As an Operator, I want numeric controls to require unit, min, and max, so that Agents cannot write unbounded numbers.
46. As an Operator, I want numeric bounds to be inclusive and finite, so that validation is simple and safe.
47. As an Operator, I want Int64 and UInt64 control writes rejected in v1, so that JavaScript precision loss cannot affect control values.
48. As an Operator, I want string controls constrained by allowed values, so that arbitrary text cannot be written.
49. As an Operator, I want enum-like controls to use ordered allowed values, so that Agents see stable choices.
50. As an Operator, I want boolean controls to require false and true labels, so that polarity is explicit.
51. As an Operator, I want per-control cooldowns, so that agent loops cannot rapidly oscillate equipment state.
52. As an Operator, I want optional `requireCurrentValueForConfirmation` on medium-risk controls, so that some controls cannot be prepared without seeing current state.
53. As an Operator, I want a `server.mode: readOnly` deployment, so that some deployments have no Control Surface at all.
54. As an Operator, I want `server.mode: readOnly` to reject controls config, so that read-only posture is enforced strictly.
55. As an Operator, I want `server.mode: readWrite` plus `controls.enabled: false`, so that configured controls can be visible but not executable during commissioning or maintenance.
56. As an Operator, I want config changes to require restart in v1, so that the local stdio architecture stays simple and auditable.
57. As an Operator, I want strict config validation to reject unknown fields, so that typos do not silently weaken safety.
58. As an Operator, I want literal secrets rejected in YAML, so that secrets are not accidentally committed.
59. As an Operator, I want secret fields to use environment variable references, so that credentials stay outside versioned config.
60. As an Operator, I want config summaries to redact auth secrets, so that Agents do not see credentials.
61. As an Operator, I want a deterministic non-secret config hash, so that audit records can identify the active policy.
62. As an Operator, I want online validation to detect missing Nodes, datatype mismatches, unreadable read roots, and unwritable controls, so that config drift becomes visible.
63. As an Operator, I want online-invalid Semantic Controls disabled automatically but listed with reasons, so that Agents can explain unavailable controls.
64. As an Operator, I want the MCP Server to start disconnected if the OPC UA Server is offline, so that status and diagnostics remain available.
65. As an Operator, I want control writes to fail when disconnected, so that stale Control Operations are never queued.
66. As an Operator, I want control writes to avoid automatic retries, so that one Agent intent does not become multiple physical commands.
67. As an Operator, I want writes verified by readback where possible, so that accepted writes are distinguished from achieved state.
68. As an Operator, I want all Control Attempts audited, including prepares, commits, rejections, and OPC UA errors, so that incidents can be reconstructed.
69. As an Operator, I want audit logging failures to block control writes, so that Control Operations cannot happen without a record.
70. As an Operator, I want audit records before and after actual writes, so that crashes during writes leave evidence of attempted control.
71. As an Operator, I want audit records in JSON Lines, so that logs are append-friendly and machine-parseable.
72. As an Operator, I want the Agent's reason preserved in audit records with a size limit, so that intent is captured without unbounded log entries.
73. As a developer, I want the OPC UA integration behind an `OpcUaGateway` interface, so that policy and tool behavior can be tested without a live OPC UA Server.
74. As a developer, I want audit logging behind an `AuditSink` interface, so that fail-closed behavior can be tested deterministically.
75. As a developer, I want config validation split into pure local validation and networked online validation, so that safety rules are easy to test.
76. As a developer, I want Zod schemas for config and tool contracts, so that runtime validation and TypeScript types stay aligned.
77. As a developer, I want optional real OPC UA integration tests, so that normal CI does not require local industrial infrastructure.
78. As a developer, I want write integration tests to require explicit environment flags and safe NodeIds, so that accidental writes do not occur.
79. As a developer, I want no demo OPC UA Server in v1, so that development targets the existing local OPC UA Server and avoids maintaining a simulator.
80. As a future maintainer, I want an ADR documenting why the MCP Server uses Semantic Controls rather than arbitrary writes, so that the safety posture is not mistaken for missing functionality.

## Implementation Decisions

- Build the MCP Server in TypeScript/Node.js.
- Ship as a library plus CLI package with a binary named `opcua-mcp`.
- Target local stdio MCP operation for v1.
- Connect to exactly one OPC UA Server endpoint per MCP Server process.
- Maintain a persistent OPC UA connection with automatic reconnect/backoff.
- Start the MCP Server after local config validation even when the OPC UA Server is unreachable; expose disconnected status while reconnecting.
- Use strict YAML config only in v1.
- Require explicit `server.mode` in config.
- Use `server.mode: readOnly` to remove the Control Surface entirely.
- Use `server.mode: readWrite` to allow the Control Surface to exist.
- Require `controls.enabled` explicitly when `server.mode: readWrite`.
- Treat `controls.enabled: false` as a runtime/deployment switch that keeps configured controls visible as unavailable while rejecting writes after restart.
- Require restart for config changes in v1; do not implement live reload or an admin control channel yet.
- Define Read Scopes with roots, explicit Nodes, and exclusions.
- Allow labels for configured read roots and explicit read Nodes; labels must be globally unique snake_case agent-facing names.
- Browse only forward hierarchical OPC UA references in v1.
- Cap browse depth using configured defaults and maximums.
- Add `read_nodes` for batched reads with configurable maximum batch size, default 50.
- Return per-node results for batched reads.
- Return OPC UA status codes and timestamps in read results where available.
- Normalize read values only when configured value mappings exist via Semantic Controls or explicit read-node metadata.
- Expose only minimal resources: status, config summary, and read-scope summary.
- Use tools for parameterized operations and live reads.
- Expose writes only through Semantic Controls.
- Do not allow Agents to write arbitrary NodeIds.
- Allow Semantic Control target NodeIds to live outside the agent-facing Read Scope.
- Allow internal safety reads for Control Confirmation and Write Verification even when the target NodeId is outside Read Scope.
- Keep agent-facing `read_node` limited to the Read Scope.
- Reject high-risk Semantic Controls in v1.
- Support low-risk direct writes and medium-risk prepare/commit Control Confirmation.
- Require a reason for medium-risk Control Confirmation; allow optional reason for low-risk writes.
- Use opaque in-memory confirmation tokens in v1.
- Bind confirmation tokens to the control name, normalized value, reason, observed current value when present, config hash, connection generation, and expiry.
- Invalidate prepared tokens when expired, after reconnect, when current value changes from the observed prepared value, or when target availability changes.
- Enforce cooldown only at write/commit time, while prepare may report commit availability.
- Support writable OPC UA data types `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String` in v1.
- Reject `Int64` and `UInt64` control writes in v1.
- Require numeric controls to define finite inclusive `min`, `max`, and `unit`.
- Require enum-like and string controls to use ordered allowed values.
- Require boolean controls to define false and true labels.
- Accept both raw booleans and configured labels for boolean control inputs.
- Return both normalized labels and raw values where mappings exist.
- Perform write verification by readback when possible.
- Treat accepted writes with mismatched readback as `write_accepted_verification_failed`.
- Do not queue Control Operations while disconnected.
- Do not automatically retry control writes.
- Return expected domain and operational failures as structured tool responses rather than MCP protocol errors.
- Reserve MCP protocol errors for malformed tool arguments, internal exceptions, and server bugs.
- Implement append-only audit as JSON Lines in v1.
- Audit every Control Attempt, including preparation attempts and rejected commits.
- Fail closed for control writes when audit logging is unavailable.
- Emit before-and-after audit events for actual writes.
- Preserve the Agent-provided reason in audit records with a configured size limit.
- Compute and expose a deterministic non-secret config hash.
- Include resolved non-secret values and secret reference names in config hash semantics while excluding secret values.
- Reject literal secrets in config secret fields; require environment variable references.
- Redact secrets from config summaries, logs, and MCP resources.
- Use an `OpcUaGateway` interface as the seam between policy/tool logic and the OPC UA client library.
- Use an `AuditSink` interface as the seam between control logic and audit storage.
- Use Zod for config schemas and tool input/output validation.
- Keep `node-opcua` behind the gateway implementation.
- Provide CLI commands for serving, validating config, and eventually generating inactive draft allowlist entries.
- Generate draft Semantic Control entries into separate inactive files only; never activate generated controls automatically.

## Testing Decisions

Testing should verify external behavior and safety invariants rather than implementation details. Tests should assert what Agents, Operators, and developers observe: accepted config, rejected unsafe config, structured tool outputs, audit records, read/write policy decisions, and OPC UA gateway interactions at the boundary.

Testing seams:

- Config validation through pure schema/local-validation functions.
- Read Scope policy through functions that resolve labels, roots, explicit Nodes, exclusions, and batch limits.
- Control policy through functions that list availability, normalize values, enforce risk rules, enforce cooldowns, and reject unavailable controls.
- Control Confirmation through an in-memory token store tested at the service boundary.
- Write execution through a mocked `OpcUaGateway` and mocked/failing `AuditSink`.
- Audit behavior through an in-memory `AuditSink`, a failing `AuditSink`, and JSON Lines sink tests.
- MCP tool contracts through contract tests over the tool handlers, using mocked gateway and audit dependencies.
- OPC UA library behavior through optional real-server integration tests gated by environment variables.

Specific testing decisions:

- Unit tests mock `OpcUaGateway`; policy and MCP tool tests should not depend on a real OPC UA Server.
- Unit tests use in-memory and failing `AuditSink` implementations to prove fail-closed semantics.
- Config tests cover strict unknown-field rejection, read-only mode rejecting controls, readWrite requiring controls, secret literal rejection, high-risk rejection, datatype constraints, numeric bounds, duplicate labels, and exclusion conflicts.
- Value normalization tests cover numeric bounds, finite-number rejection, enum label/raw handling, string allowed values, and boolean label/raw handling.
- Read tests cover NodeId and label input, Read Scope enforcement, exclusion behavior, batch partial success, max batch size, timestamps, status codes, and configured value mappings.
- Browse tests cover root browsing, NodeId browsing, label browsing, depth caps, hierarchical-reference-only behavior, and metadata-only output.
- Control listing tests cover full callable details, unavailable reason arrays, controls disabled, disconnected gateway, online validation pending/failed, cooldown, and audit unavailable states.
- Direct write tests cover low-risk only, medium-risk rejection with `confirmation_required`, value validation, audit-before/write/audit-after ordering, no retry, no queuing, OPC UA errors, unknown outcomes, and verification mismatch.
- Control Confirmation tests cover reason required, prepare audit, current-value optional behavior, `requireCurrentValueForConfirmation`, token expiry, reconnect invalidation, current-value-change invalidation, cooldown at commit, and commit audit for token failures.
- Contract tests verify representative JSON shapes without overusing brittle full snapshots.
- Real OPC UA integration tests are opt-in and skipped unless `OPCUA_TEST_ENDPOINT` and related environment variables are set.
- Real write integration tests are additionally skipped unless `OPCUA_TEST_ENABLE_WRITES=true`, a safe write NodeId, and a safe value are provided.
- No demo OPC UA Server is required for v1.

## Out of Scope

- OPC UA method calls.
- OPC UA subscriptions or streaming updates.
- Multiple OPC UA Server endpoints in one MCP Server process.
- Remote/shared MCP Server authentication and multi-tenant authorization.
- Live config reload.
- Admin MCP tools for reload or policy mutation.
- Agent-created or agent-activated allowlist changes.
- Arbitrary raw NodeId writes.
- High-risk Semantic Controls.
- Complex OPC UA values such as arrays, ExtensionObjects, and structures.
- Int64 and UInt64 control writes.
- Automatic retries for control writes.
- Queued control writes while disconnected.
- Read auditing by default.
- Stale-value rejection based on timestamp age.
- Demo OPC UA Server.
- Proving human approval for Control Confirmation.
- External policy services.
- Kubernetes-specific ConfigMap workflows.

## Further Notes

The domain glossary is maintained in `CONTEXT.md`. The key architectural decision is recorded in ADR 0001: agent control is constrained through Operator-approved Semantic Controls rather than arbitrary OPC UA writes.

The initial scaffold already includes strict TypeScript, strict Zod config schema work, linting, formatting, tests, security documentation, sample configs, and initial module seams for `OpcUaGateway` and `AuditSink`.

The issue tracker and label vocabulary were not available in this workspace, so this PRD has been written to `docs/prd.md` rather than published to an issue tracker.
