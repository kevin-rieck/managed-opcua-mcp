# PRD: OPC UA MCP Server

## Problem Statement

Agents need a practical way to inspect and operate an OPC UA Server through MCP without requiring Operators to duplicate the OPC UA Server's access-control model in MCP configuration.

OPC UA Server credentials and roles are the authorization boundary for reading and for the underlying write permission. The MCP Server should use those rights instead of maintaining a comprehensive local read/write permission configuration. MCP configuration should stay small: connection settings, optional Read Entry Points for discovery, optional Semantic Controls for safe agent-facing writes, and audit settings.

## Solution

Build a TypeScript/Node.js MCP Server that connects to one configured OPC UA Server endpoint over a persistent OPC UA session and exposes:

- generic browse/read tools that rely on OPC UA Server authorization
- optional Read Entry Points that give agents useful discovery roots
- Semantic Controls for Operator-defined writes, collected in a Control Catalog
- Control Confirmation for medium-risk Semantic Controls
- append-only audit logging for all Control Attempts
- strict YAML configuration with no literal secrets
- local stdio operation for v1

The MCP Server will not expose arbitrary raw NodeId writes to Agents. Server-side OPC UA authorization decides whether the MCP process may write the target Node; Semantic Controls decide how that write is presented to Agents, including validation rules, risk notes, cooldowns, confirmation, and audit context.

## User Stories

1. As an Agent, I want to inspect MCP Server status, so that I know whether the OPC UA Server is connected.
2. As an Agent, I want sanitized error summaries, so that I get useful operational feedback without seeing sensitive internals.
3. As an Agent, I want configured Read Entry Points, so that I know where browsing can begin.
4. As an Agent, I want to browse by NodeId, so that I can inspect the OPC UA address space available to the MCP process.
5. As an Agent, I want to browse configured Read Entry Points without knowing a starting NodeId, so that discovery is easy.
6. As an Agent, I want browse results to include NodeIds, browse names, display names, node classes, data types, and capability flags, so that I can understand what each Node represents.
7. As an Agent, I want browse results to omit current values, so that browsing remains cheap and structural.
8. As an Agent, I want browse depth to be bounded, so that I do not accidentally traverse a huge address space.
9. As an Agent, I want to read one or more Nodes by NodeId, so that I can inspect current values.
10. As an Agent, I want batch reads to return per-node results, so that one bad or unauthorized Node does not hide successful reads.
11. As an Agent, I want read results to include OPC UA status codes and timestamps, so that I can judge data freshness and quality.
12. As an Agent, I want OPC UA access-denied and other expected operational failures returned as structured tool responses, so that I can reason over them programmatically.
13. As an Agent, I want to list Semantic Controls, so that I know what Control Operations are available.
14. As an Agent, I want unavailable Semantic Controls listed with machine-readable reasons, so that I can explain why a control cannot run.
15. As an Agent, I want Semantic Controls to include descriptions, Risk Levels, Risk Notes, value constraints, units, cooldowns, and confirmation requirements, so that I can choose controls safely.
16. As an Agent, I want low-risk Semantic Controls to be executable with one tool call, so that harmless or simulation-safe operations stay simple.
17. As an Agent, I want medium-risk Semantic Controls to require prepare/commit Control Confirmation, so that risky operations are deliberate.
18. As an Agent, I want write results to include requested values, raw values, OPC UA status, verification results, and audit IDs, so that I know what happened.
19. As an Operator, I want OPC UA Server credentials and roles to define MCP read/write rights, so that access policy has one source of truth.
20. As an Operator, I want optional Read Entry Points in YAML, so that Agents have useful starting points without requiring a comprehensive read policy.
21. As an Operator, I want to define Semantic Controls in YAML, so that agent-facing Control Operations are explicit, understandable, and versionable.
22. As an Operator, I want a Control Catalog that does not replace OPC UA Server authorization, so that Semantic Controls describe safe interaction rather than duplicate permissions.
23. As an Operator, I want high-risk Semantic Controls rejected in v1, so that the first version cannot expose dangerous operations.
24. As an Operator, I want numeric controls to require unit, min, and max, so that Agents cannot write unbounded numbers.
25. As an Operator, I want string and enum-like controls constrained by ordered allowed values, so that arbitrary text or unclear values cannot be written.
26. As an Operator, I want boolean controls to require false and true labels, so that polarity is explicit.
27. As an Operator, I want per-control cooldowns, so that agent loops cannot rapidly oscillate equipment state.
28. As an Operator, I want `controls.enabled: false` as an optional commissioning switch, so that configured controls can be visible but not executable.
29. As an Operator, I want config changes to require restart in v1, so that the local stdio architecture stays simple and auditable.
30. As an Operator, I want strict config validation to reject unknown fields, so that typos do not silently weaken safety.
31. As an Operator, I want literal secrets rejected in YAML and secret fields to use environment variable references, so that credentials stay outside versioned config.
32. As an Operator, I want config summaries to redact auth secrets, so that Agents do not see credentials.
33. As an Operator, I want a deterministic non-secret config hash, so that audit records can identify the active policy.
34. As an Operator, I want online validation to detect missing Control target Nodes, datatype mismatches, and unwritable controls, so that Control Catalog drift becomes visible.
35. As an Operator, I want control writes to fail when disconnected, avoid automatic retries, and never queue, so that one Agent intent does not become multiple physical commands.
36. As an Operator, I want writes verified by readback where possible, so that accepted writes are distinguished from achieved state.
37. As an Operator, I want all Control Attempts audited, including prepares, commits, rejections, and OPC UA errors, so that incidents can be reconstructed.
38. As a developer, I want the OPC UA integration behind an `OpcUaGateway` interface, so that policy and tool behavior can be tested without a live OPC UA Server.
39. As a developer, I want config validation split into pure local validation and networked online validation, so that safety rules are easy to test.
40. As a future maintainer, I want ADRs documenting why access authorization lives in the OPC UA Server and why writes still use Semantic Controls, so that the safety posture is not mistaken for missing functionality.

## Implementation Decisions

- Build the MCP Server in TypeScript/Node.js.
- Ship as a library plus CLI package with a binary named `opcua-mcp`.
- Target local stdio MCP operation for v1.
- Connect to exactly one OPC UA Server endpoint per MCP Server process.
- Maintain a persistent OPC UA connection with automatic reconnect/backoff.
- Start the MCP Server after local config validation even when the OPC UA Server is unreachable; expose disconnected status while reconnecting.
- Use strict YAML config only in v1.
- Remove `server.mode`; the Control Surface exists when `controls.items` are configured.
- Make `controls.enabled` optional and default it to `true` when controls are configured.
- Treat `controls.enabled: false` as a runtime/deployment switch that keeps configured controls visible as unavailable while rejecting writes after restart.
- Require restart for config changes in v1; do not implement live reload or an admin control channel yet.
- Replace configured Read Scopes with optional Read Entry Points under `read.roots`.
- Treat Read Entry Points as discovery/navigation aids, not authorization boundaries.
- Let `browse_node(nodeId)` and `read_node(nodeId)` attempt any NodeId; OPC UA Server authorization determines success.
- Return OPC UA access-denied and other expected operational failures as structured tool responses.
- Keep browse depth and read batch size bounded by `read.defaultBrowseDepth`, `read.maxBrowseDepth`, and `read.maxReadBatchSize`.
- Remove read exclusions and explicit read-node allowlists from v1.
- Remove read-only value mapping config from v1.
- Normalize read values only when a read Node corresponds to a configured Semantic Control target.
- Expose only minimal resources: status, config summary, and read entry point summary.
- Use tools for parameterized operations and live reads.
- Expose writes only through Semantic Controls.
- Do not allow Agents to write arbitrary NodeIds.
- Collect Semantic Controls in a Control Catalog.
- Reject high-risk Semantic Controls in v1.
- Support low-risk direct writes and medium-risk prepare/commit Control Confirmation.
- Require a reason for medium-risk Control Confirmation; allow optional reason for low-risk writes.
- Use opaque in-memory confirmation tokens in v1.
- Enforce cooldown only at write/commit time, while prepare may report commit availability.
- Support writable OPC UA data types `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String` in v1.
- Reject `Int64` and `UInt64` control writes in v1.
- Require numeric controls to define finite inclusive `min`, `max`, and `unit`.
- Require enum-like and string controls to use ordered allowed values.
- Require boolean controls to define false and true labels.
- Perform write verification by readback when possible.
- Do not queue Control Operations while disconnected.
- Do not automatically retry control writes.
- Return expected domain and operational failures as structured tool responses rather than MCP protocol errors.
- Reserve MCP protocol errors for malformed tool arguments, internal exceptions, and server bugs.
- Implement append-only audit as JSON Lines in v1.
- Audit every Control Attempt, including preparation attempts and rejected commits.
- Fail closed for control writes when audit logging is unavailable.
- Compute and expose a deterministic non-secret config hash.
- Reject literal secrets in config secret fields; require environment variable references.
- Redact secrets from config summaries, logs, and MCP resources.
- Use an `OpcUaGateway` interface as the seam between policy/tool logic and the OPC UA client library.
- Use an `AuditSink` interface as the seam between control logic and audit storage.
- Use Zod for config schemas and tool input/output validation.
- Keep `node-opcua` behind the gateway implementation.

## Canonical Config Shape

```yaml
version: 1

connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: None
  securityPolicy: None
  auth:
    type: anonymous

read:
  defaultBrowseDepth: 1
  maxBrowseDepth: 10
  maxReadBatchSize: 50
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
      description: Main machine address space.

audit:
  file: ./audit.jsonl
  maxReasonLength: 1000

controls:
  enabled: true # optional; defaults to true when controls are configured
  defaults:
    cooldownMs: 1000
    mediumConfirmationTtlMs: 60000
  items:
    - name: set_motor_speed
      group: line_1/motor_3
      description: Sets the motor speed setpoint.
      nodeId: ns=2;s=Motor.SpeedSetpoint
      dataType: Double
      unit: rpm
      min: 0
      max: 1800
      riskLevel: medium
      riskNote: Changes motor speed; verify downstream equipment is ready.
      cooldownMs: 5000
```

## Testing Decisions

Testing should verify external behavior and safety invariants rather than implementation details. Tests should assert what Agents, Operators, and developers observe: accepted config, rejected unsafe config, structured tool outputs, audit records, control decisions, and OPC UA gateway interactions at the boundary.

Specific testing decisions:

- Unit tests mock `OpcUaGateway`; policy and MCP tool tests should not depend on a real OPC UA Server.
- Config tests cover strict unknown-field rejection, secret literal rejection, simplified `read` config, optional `controls.enabled`, high-risk rejection, datatype constraints, numeric bounds, and duplicate Control names.
- Read tests cover root browsing, NodeId browsing, batch reads, partial success, max batch size, timestamps, status codes, and OPC UA access-denied responses.
- Read tests must not assert MCP-side authorization beyond argument validation and operational limits.
- Control listing tests cover callable details, unavailable reason arrays, controls disabled, disconnected gateway, online validation pending/failed, cooldown, and audit unavailable states.
- Direct write tests cover low-risk only, medium-risk rejection with `confirmation_required`, value validation, audit-before/write/audit-after ordering, no retry, no queuing, OPC UA access-denied/errors, unknown outcomes, and verification mismatch.
- Control Confirmation tests cover reason required, prepare audit, current-value optional behavior, token expiry, reconnect invalidation, cooldown at commit, and commit audit for token failures.
- Real OPC UA integration tests are opt-in and skipped unless `OPCUA_TEST_ENDPOINT` and related environment variables are set.
- Real write integration tests are additionally skipped unless `OPCUA_TEST_ENABLE_WRITES=true`, a safe write NodeId, and a safe value are provided.

## Out of Scope

- OPC UA method calls.
- OPC UA subscriptions or streaming updates.
- Multiple OPC UA Server endpoints in one MCP Server process.
- Remote/shared MCP Server authentication and multi-tenant authorization.
- Duplicating OPC UA Server read/write authorization in MCP config.
- Live config reload.
- Admin MCP tools for reload or policy mutation.
- Agent-created or agent-activated Control Catalog changes.
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
- Backward compatibility with the old `server.mode` / `readScope` config shape.

## Further Notes

The domain glossary is maintained in `CONTEXT.md`. ADR 0001 records the decision to expose writes through Semantic Controls rather than arbitrary raw NodeId writes. ADR 0002 records the decision to rely on OPC UA Server authorization and simplify MCP configuration.
