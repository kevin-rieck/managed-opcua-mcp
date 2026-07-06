# OPC UA MCP Server Plan

## Goal

Build a TypeScript/Node.js MCP Server that lets agents inspect and safely operate one configured OPC UA Server endpoint while relying on OPC UA Server credentials and roles for authorization.

## V1 Scope

- Local stdio MCP server.
- One OPC UA endpoint per MCP Server process.
- Persistent OPC UA connection with reconnect/backoff.
- Generic browsing and point-in-time reads, authorized by the OPC UA Server.
- Optional Read Entry Points for agent discovery.
- Operator-defined Semantic Controls for writes.
- No method calls, subscriptions, complex values, arbitrary raw writes, local read permission config, or automatic write retries.

## Safety Posture

- OPC UA Server credentials and roles are the authorization boundary for reads and underlying writes.
- MCP read configuration provides discovery roots, not permissions.
- Writes are exposed only as Semantic Controls in a Control Catalog.
- Agents cannot write raw NodeIds.
- High-risk Semantic Controls are rejected in v1.
- Medium-risk Semantic Controls require Control Confirmation.
- Control Confirmation is a deliberate two-step API, not proof of human approval.
- Control attempts are audited append-only, including failures and preparation attempts.
- Control writes fail closed if audit logging is unavailable.
- Control writes are never queued while disconnected and are not automatically retried.
- Numeric controls require inclusive `min`, `max`, and `unit`.
- String controls require `allowedValues`.
- Enum-like controls use ordered `allowedValues` lists.
- Boolean controls require `falseLabel` and `trueLabel`.

## Configuration

V1 uses strict YAML config. Unknown fields fail validation.

Secrets are referenced through environment variables, not stored literally in config. Literal secret values are rejected in v1.

Config includes:

- OPC UA connection settings
- optional Read Entry Points and operational read limits
- optional Semantic Controls in a Control Catalog
- optional `controls.enabled` commissioning switch
- audit/logging settings

There is no `server.mode`. If `controls.items` are configured, the Control Surface exists. If `controls.enabled` is omitted, it defaults to `true`. If `controls.enabled: false`, controls remain visible but unavailable.

Canonical config shape:

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

### Read Entry Point rules

- `read.roots` is optional.
- Read Entry Point labels are optional, globally unique snake_case names.
- `browse_node()` without a NodeId returns configured Read Entry Points when present.
- If no Read Entry Points are configured, `browse_node()` may return standard OPC UA root folders or a structured response asking for a NodeId.
- `browse_node(nodeId)` attempts to browse the requested NodeId and reports OPC UA authorization/operation results.
- `read_node(nodeId)` and `read_nodes([...])` attempt to read requested NodeIds and report OPC UA authorization/operation results.
- Read Entry Points do not restrict `browse_node(nodeId)` or `read_node(nodeId)`.
- There is no `read.nodes` explicit allowlist in v1.
- There is no `read.exclude` in v1.
- There is no read-only value mapping config in v1.
- `read.defaultBrowseDepth` and `read.maxBrowseDepth` bound browse traversal.
- `read.maxReadBatchSize` limits `read_nodes`; default is 50.

### Semantic Control rules

Each Semantic Control includes:

- globally unique snake_case `name`
- required `description`
- NodeId
- OPC UA built-in data type
- validation rules
- Risk Level and Risk Note
- optional group metadata
- cooldown settings

Control data type rules:

- Writable data types use OPC UA built-in type names.
- V1 supports control writes for `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String`.
- V1 rejects `Int64` and `UInt64` control writes because JavaScript cannot safely represent all 64-bit integer values.
- Numeric control bounds and values must be finite numbers; `NaN`, `Infinity`, and `-Infinity` are rejected.
- Integer bounds must fit both the OPC UA datatype range and the Operator's configured process range.
- Enum-like controls use ordered `allowedValues` entries, where labels are snake_case and raw values match the configured data type.
- Enum labels are unique only within a single control.
- Boolean controls require snake_case `falseLabel` and `trueLabel` values.
- Boolean write inputs may use either raw booleans or the configured labels; responses and audit entries include both normalized label and raw value.
- Semantic Control names should usually describe setting a state, such as `set_motor_speed`, but validation only enforces globally unique snake_case names.

Example boolean control:

```yaml
- name: set_pump_enabled
  description: Enables or disables the pump.
  nodeId: ns=2;s=Pump.Enabled
  dataType: Boolean
  falseLabel: disabled
  trueLabel: enabled
  riskLevel: medium
  riskNote: Enabling the pump may start fluid movement.
```

Example enum-like control:

```yaml
- name: set_machine_mode
  description: Sets the machine operating mode.
  nodeId: ns=2;s=Machine.Mode
  dataType: Int32
  allowedValues:
    - label: idle
      value: 0
    - label: automatic
      value: 1
    - label: maintenance
      value: 2
  riskLevel: medium
  riskNote: Changing mode can start or stop automatic behavior.
```

## Validation

Validation has two levels:

1. Local validation
   - strict schema
   - required fields
   - safety policy
   - coherent value constraints
2. Online validation
   - connection can authenticate when the OPC UA Server is reachable
   - Read Entry Points exist/browse where possible
   - control Nodes exist
   - control Nodes are writable by the configured OPC UA credentials
   - configured control data types match OPC UA metadata

Invalid local config fails startup. If the OPC UA Server is unreachable, the MCP Server starts disconnected and reconnects. Online-invalid Semantic Controls are shown as unavailable with reasons.

## MCP Resources

V1 resources are minimal convenience resources. Parameterized operations and live reads use tools.

- `opcua://status`
- `opcua://config/summary`
- `opcua://read-entry-points`

`opcua://status` includes connection state, sanitized last error summary, server status if known, last successful health check timestamp, online validation state, control availability counts, `controls.enabled`, audit health, and config hash.

`opcua://config/summary` includes non-secret policy/config details such as endpoint URL, security mode/policy, auth type with secret fields redacted, Read Entry Point summary, Semantic Control summaries, audit file path, and config hash.

`opcua://read-entry-points` includes configured Read Entry Points only. It does not expand the browse tree and does not describe a permission boundary.

## MCP Tools

- `browse_node(nodeId?, label?, depth?)`
- `read_node(nodeId)`
- `read_nodes(nodes: Array<{nodeId: string}>)`
- `list_controls()`
- `write_control(controlName, value, reason?)` for low-risk controls only
- `prepare_control(controlName, value, reason)` for medium-risk controls
- `commit_control(token)`

### `browse_node(nodeId?, label?, depth?)`

If no identifier is supplied, `browse_node` returns configured Read Entry Points when present. If an identifier is supplied, exactly one of `nodeId` or `label` must be provided. Labels resolve only from configured Read Entry Points.

`browse_node` browses forward hierarchical OPC UA references only in v1. The requested browse is attempted with the configured OPC UA credentials; access denial is returned as a structured result.

Browse results include metadata only, not current values. Returned children include node class and capability flags when available.

Example child:

```json
{
  "nodeId": "ns=2;s=Machine.State",
  "browseName": "2:State",
  "displayName": "State",
  "nodeClass": "Variable",
  "dataType": "Int32",
  "readable": true,
  "writable": false,
  "callable": false
}
```

### `read_node(nodeId)` and `read_nodes(nodes)`

`read_node` and `read_nodes` accept NodeIds. Reads are attempted with the configured OPC UA credentials. OPC UA access denial and read failures are returned as structured per-node results.

`read_nodes` uses per-node results and supports partial success. It is limited by `read.maxReadBatchSize`, default 50.

Read status values are:

- `succeeded`
- `rejected`
- `opcua_error`

Successful read results include NodeId, value, data type where available, OPC UA status code, source timestamp, and server timestamp. If the NodeId corresponds to a Semantic Control target, configured labels/units may be included.

### `list_controls()`

`list_controls()` is available when Semantic Controls are configured. It remains available when `controls.enabled: false` so Agents can see configured controls as unavailable.

It returns full agent-facing callable details, excluding secrets and internal-only fields. It does not read current OPC UA values by default.

Unavailable reason codes include `controls_disabled`, `opcua_disconnected`, `online_validation_pending`, `online_validation_failed`, `cooldown_active`, `audit_unavailable`, `control_not_found`, `unsupported_data_type`, and `opcua_access_denied`.

### Control tool response semantics

Expected operational failures are structured tool results, not MCP protocol errors. MCP protocol errors are reserved for malformed tool arguments, server bugs, and unexpected internal exceptions.

Control write result statuses include:

- `succeeded`
- `rejected`
- `opcua_error`
- `unknown_outcome`
- `write_accepted_verification_failed`

### `write_control(controlName, value, reason?)`

`write_control` is only for low-risk controls. Medium-risk controls reject with reason code `confirmation_required` and instruct the Agent to use `prepare_control` and `commit_control`.

`write_control` performs validation, availability checks, cooldown enforcement, audit checks, OPC UA write, and Write Verification. If the OPC UA Server denies the write, the response is a structured rejection or OPC UA error result.

### `prepare_control(controlName, value, reason)` and `commit_control(token)`

`prepare_control` validates the requested value, reads current state when possible, returns the Risk Level/Risk Note, and issues a short-lived token. `reason` is required for medium-risk controls.

`commit_control(token)` accepts only the opaque token. The token binds the control name, value, reason, observed current value when present, config hash, connection generation, and expiry.

`commit_control` rechecks availability, cooldown, audit health, connection state, token validity, and OPC UA authorization before writing.

## Audit

Append-only audit log uses a JSON Lines file and records every Control Attempt with before-and-after events for actual writes.

Audit records include timestamp, event/result, control name, NodeId, requested values, Risk Level, caller identity when available, config hash, OPC UA status when available, reason, and error fields.

If audit logging is unavailable, prepare/write/commit operations fail closed before OPC UA writes.

## Testing

Unit tests mock the `OpcUaGateway` interface for read, control confirmation, write verification, and failure behavior. Unit tests use an in-memory `AuditSink` and failing `AuditSink` to verify audit behavior and fail-closed control semantics.

Testing focus:

- config loader and Zod schema validator
- simplified read config
- OPC UA access-denied read/write behavior as structured results
- Control Catalog evaluator
- value normalization for Semantic Controls
- control confirmation token store
- audit sink behavior
- MCP tool/resource contracts

Integration tests against a real OPC UA Server are opt-in. Integration write tests are skipped unless `OPCUA_TEST_ENABLE_WRITES=true` and a safe write NodeId/value are provided.

## Migration from old draft config

This is a breaking schema change. There is no compatibility adapter.

- Remove `server.mode`.
- Rename `readScope.roots` to `read.roots`.
- Rename `readScope.defaultDepth` to `read.defaultBrowseDepth`.
- Rename `readScope.maxDepth` to `read.maxBrowseDepth`.
- Rename `readScope.maxReadBatchSize` to `read.maxReadBatchSize`.
- Remove `readScope.nodes`.
- Remove `readScope.exclude`.
- Keep `controls.enabled` only when an explicit commissioning/maintenance switch is needed; otherwise omit it.

## ADRs

- ADR 0001: Semantic Controls rather than arbitrary raw NodeId writes.
- ADR 0002: OPC UA Server authorization and simplified MCP configuration.
