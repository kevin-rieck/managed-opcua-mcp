# OPC UA MCP Server Plan

## Goal

Build a TypeScript/Node.js MCP Server that lets agents inspect and safely operate one configured OPC UA Server endpoint.

## V1 Scope

- Local stdio MCP server.
- One OPC UA endpoint per MCP Server process.
- Persistent OPC UA connection with reconnect/backoff.
- Scoped browsing and point-in-time reads.
- Operator-approved Semantic Controls for writes.
- No method calls, subscriptions, complex values, arbitrary writes, or automatic write retries.

## Safety Posture

- Reads are limited by configured Read Scopes.
- Writes are exposed only as Semantic Controls.
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

## Deployment Modes

`server.mode` determines whether the Control Surface exists. `controls.enabled` determines whether configured Semantic Controls can currently execute writes.

- `server.mode: readOnly`
  - exposes no control tools
  - rejects configs containing control items
- `server.mode: readWrite`
  - may expose control tools
  - requires `controls.enabled` to be set explicitly
  - `controls.enabled: false` keeps configured controls visible as unavailable and rejects all writes after process restart

## Config

V1 uses strict YAML config. Unknown fields fail validation.

Secrets are referenced through environment variables, not stored literally in config. Literal secret values are rejected in v1.

The MCP Server computes a non-secret deterministic config hash after environment interpolation. Resolved non-secret values affect the hash; secret reference names affect the hash, but secret values do not.

Config includes:

- OPC UA connection settings
- Read Scope roots, explicit readable nodes, and optional exclusions
- Semantic Controls, whose target NodeIds do not have to be inside the Read Scope
- control availability flags under `controls.enabled`
- audit/logging settings

Canonical config shape:

```yaml
version: 1

server:
  mode: readWrite # readOnly | readWrite

connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: None
  securityPolicy: None
  auth:
    type: anonymous

readScope:
  defaultDepth: 3
  maxDepth: 10
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
      description: Main machine address space.
      depth: 5
  nodes:
    - nodeId: ns=2;s=Machine.State
      label: machine_state
      description: Current machine operating state.
  exclude:
    - nodeId: ns=2;s=Machine.Diagnostics
      kind: subtree
    - nodeId: ns=2;s=Machine.SecretRecipe
      kind: exact

audit:
  file: ./audit.jsonl
  maxReasonLength: 1000

controls:
  enabled: true
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

Read Scope rules:

- `browse_node()` without a NodeId returns configured Read Scope roots.
- Browse depth defaults to `readScope.defaultDepth` and is capped by `readScope.maxDepth`.
- Root and explicit-node labels are optional, but if present they must be globally unique snake_case agent-facing names.
- Exclusions require `kind: exact | subtree`.
- Exclusions apply to root-derived access.
- Explicit `readScope.nodes` are explicit grants; if the same NodeId appears in `nodes` and `exclude`, validation fails.
- Explicit read nodes may include optional value metadata: `dataType`, `unit`, enum `allowedValues`, or boolean `falseLabel`/`trueLabel`.
- Read-node value metadata uses the same mapping conventions as Semantic Controls where applicable.
- `readScope.maxReadBatchSize` limits `read_nodes`; default is 50.

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

Secret-bearing config fields are explicitly marked by the schema for redaction, hashing, summaries, and logging. Secret fields must use environment variable references in v1.

## Validation

Validation has two levels:

1. Local validation
   - strict schema
   - required fields
   - safety policy
   - coherent value constraints
2. Online validation
   - NodeIds exist
   - Read Scopes are browseable
   - control nodes are writable
   - configured data types match OPC UA metadata

Invalid local config fails startup. If the OPC UA Server is unreachable, the MCP Server starts disconnected and reconnects. Online-invalid Semantic Controls are shown as unavailable with reasons.

## MCP Resources

V1 resources are minimal convenience resources. Parameterized operations and live reads use tools.

- `opcua://status`
- `opcua://config/summary`
- `opcua://read-scope`

`opcua://status` includes connection state, sanitized last error summary, server status if known, last successful health check timestamp, online validation state, control availability counts, deployment mode, `controls.enabled`, audit health, and config hash.

`opcua://config/summary` includes non-secret policy/config details such as endpoint URL, security mode/policy, auth type with secret fields redacted, Read Scope summary, Semantic Control summaries, audit file path, and config hash.

`opcua://read-scope` includes configured roots, explicit nodes, and exclusions only. It does not expand the browse tree.

## MCP Tools

- `browse_node(nodeId?|label?, depth?)`
- `read_node(nodeId|label)`
- `read_nodes(nodes: Array<{nodeId?|label?}>)`
- `list_controls()`
- `write_control(controlName, value)` for low-risk controls only
- `prepare_control(controlName, value, reason)` for medium-risk controls
- `commit_control(token)`

### `browse_node(nodeId?|label?, depth?)`

`browse_node` browses forward hierarchical OPC UA references only in v1. If no identifier is supplied, it returns the configured Read Scope roots. If an identifier is supplied, exactly one of `nodeId` or `label` must be provided.

Labels resolve only from configured read roots and explicit read nodes, not dynamic browse children. Returned results always include NodeIds.

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
  "callable": false,
  "withinReadScope": true
}
```

### `read_node(nodeId|label)` and `read_nodes(nodes)`

`read_node` and `read_nodes` accept either NodeIds or configured labels. Reads are limited to the agent-facing Read Scope; internal safety reads for Semantic Controls do not grant general read access.

`read_nodes` uses per-node results and supports partial success. It is limited by `readScope.maxReadBatchSize`, default 50.

Read status values are:

- `succeeded`
- `rejected`
- `opcua_error`
- `unknown_outcome`

`read_node` uses the same shape as a single `read_nodes` result.

Example read result:

```json
{
  "status": "succeeded",
  "nodeId": "ns=2;s=Machine.Mode",
  "label": "machine_mode",
  "value": "automatic",
  "rawValue": 1,
  "dataType": "Int32",
  "unit": null,
  "opcuaStatus": "Good",
  "sourceTimestamp": "2026-07-04T12:00:00.000Z",
  "serverTimestamp": "2026-07-04T12:00:00.010Z"
}
```

Configured enum/boolean mappings are normalized in read results when the NodeId corresponds to a configured Semantic Control or explicit read-node value mapping. Otherwise, reads return raw OPC UA values. V1 returns OPC UA timestamps and status codes when available, but does not reject stale values based on timestamp age.

### `list_controls()`

`list_controls()` is available only when `server.mode: readWrite`. It remains available when `controls.enabled: false` so agents can see configured controls as unavailable.

It returns full agent-facing callable details, excluding secrets and internal-only fields. It does not read current OPC UA values by default.

Example numeric control:

```json
{
  "name": "set_motor_speed",
  "group": "line_1/motor_3",
  "description": "Sets the motor speed setpoint.",
  "nodeId": "ns=2;s=Motor.SpeedSetpoint",
  "available": true,
  "unavailableReasons": [],
  "riskLevel": "medium",
  "riskNote": "Changes motor speed; verify downstream equipment is ready.",
  "confirmationRequired": true,
  "requiresReason": true,
  "value": {
    "dataType": "Double",
    "kind": "number",
    "unit": "rpm",
    "min": 0,
    "max": 1800
  },
  "cooldownMs": 5000
}
```

Example enum value metadata:

```json
{
  "dataType": "Int32",
  "kind": "enum",
  "allowedValues": [
    { "label": "idle", "rawValue": 0 },
    { "label": "automatic", "rawValue": 1 }
  ]
}
```

Example boolean value metadata:

```json
{
  "dataType": "Boolean",
  "kind": "boolean",
  "falseLabel": "disabled",
  "trueLabel": "enabled"
}
```

`available` is true only when `unavailableReasons` is empty. Reason codes are machine-readable and include messages for humans. Candidate codes include `controls_disabled`, `opcua_disconnected`, `online_validation_pending`, `online_validation_failed`, `cooldown_active`, `audit_unavailable`, `control_not_found`, and `unsupported_data_type`.

### Control tool response semantics

Expected domain and operational rejections are returned as structured tool responses, not MCP protocol errors. MCP errors are reserved for malformed tool arguments, internal exceptions, and server bugs.

Control execution status values for v1 are:

- `succeeded`
- `rejected`
- `opcua_error`
- `unknown_outcome`
- `write_accepted_verification_failed`

### `write_control(controlName, value, reason?)`

`write_control` is only for low-risk controls. Medium-risk controls reject with reason code `confirmation_required` and instruct the agent to use `prepare_control` and `commit_control`.

`reason` is optional for low-risk controls. If supplied, it is size-limited and included in audit entries.

`write_control` performs the same validation, availability checks, cooldown enforcement, audit checks, OPC UA write, and Write Verification as a medium-risk commit. The only difference is that it does not use a prepare token.

Successful result shape:

```json
{
  "status": "succeeded",
  "controlName": "set_indicator_light",
  "requestedValue": "on",
  "rawRequestedValue": true,
  "opcuaStatus": "Good",
  "verification": {
    "performed": true,
    "status": "matched",
    "observedValue": "on",
    "rawObservedValue": true
  },
  "auditIds": ["..."]
}
```

If readback is unavailable:

```json
{
  "verification": {
    "performed": false,
    "reason": "target_not_readable"
  }
}
```

If the write is accepted but readback differs, the result status is `write_accepted_verification_failed`.

Expected rejection example:

```json
{
  "status": "rejected",
  "reason": {
    "code": "value_out_of_range",
    "message": "12000 is above max 1800 rpm."
  }
}
```

OPC UA operational failure example:

```json
{
  "status": "opcua_error",
  "reason": {
    "code": "opcua_bad_not_writable",
    "message": "OPC UA server returned BadNotWritable.",
    "opcuaStatus": "BadNotWritable"
  }
}
```

Unknown outcome example:

```json
{
  "status": "unknown_outcome",
  "reason": {
    "code": "opcua_timeout",
    "message": "Write timed out; outcome is unknown."
  }
}
```

Admin operations are CLI/admin-only, not normal agent tools:

- validate config
- generate inactive draft allowlist entries

Config changes require restarting the MCP Server in v1.

## Control Confirmation

Control Confirmation applies to medium-risk Semantic Controls. It uses an in-memory token store in v1.

`prepare_control(controlName, value, reason)` validates the requested value, reads current state when possible, returns the Risk Level/Risk Note, and issues a short-lived token. `reason` is required for medium-risk controls.

Prepare status values are:

- `prepared`
- `rejected`

Current-value read is optional by default. Medium-risk controls may set `requireCurrentValueForConfirmation: true`; if set, prepare rejects when current-value read fails. This option is only valid for medium-risk controls.

`prepare_control` does not enforce cooldown, but it may include commit availability information. Cooldown is rechecked by `commit_control` immediately before the write.

Prepared result shape:

```json
{
  "status": "prepared",
  "token": "opaque-token",
  "expiresAt": "2026-07-04T12:01:00Z",
  "control": {
    "name": "set_motor_speed",
    "description": "Sets the motor speed setpoint.",
    "nodeId": "ns=2;s=Motor.SpeedSetpoint",
    "riskLevel": "medium",
    "riskNote": "Changes motor speed; verify downstream equipment is ready."
  },
  "requestedValue": 1200,
  "rawRequestedValue": 1200,
  "currentValue": {
    "performed": true,
    "value": 800,
    "rawValue": 800
  },
  "commitAvailability": {
    "availableNow": true,
    "reasons": []
  },
  "auditIds": ["..."]
}
```

If current value is not readable:

```json
{
  "currentValue": {
    "performed": false,
    "reason": "target_not_readable"
  }
}
```

`commit_control(token)` accepts only the opaque token. The token binds the control name, value, reason, observed current value when present, config hash, connection generation, and expiry.

`commit_control` returns the same write result shape as `write_control`, with optional prepare metadata such as `preparedAt` and `tokenExpiresAt`.

`commit_control` performs the write only if:

- token is valid and has not expired
- OPC UA session is healthy
- MCP Server has not reconnected
- target remains allowlisted and available
- current value has not changed from the prepared observed value, when readable
- the audit sink is healthy
- cooldown permits the write

Token validation failures are audited as Control Attempts.

## Write Verification

When possible, the MCP Server reads back after a write. Internal safety reads for Control Confirmation and Write Verification may read a Semantic Control target even when that NodeId is outside the agent-facing Read Scope. Agent-facing `read_node` remains limited to the Read Scope.

If the OPC UA Server accepts the write but readback differs, the result is partial success / verification failed, not plain success.

## Audit

Append-only audit log uses a JSON Lines file and records every Control Attempt with before-and-after events for actual writes:

- timestamp
- control name
- NodeId
- requested and raw values
- result
- Risk Level
- caller/session identity if available
- config version/hash
- OPC UA status code
- reason/error message

The agent-provided reason is preserved verbatim as a size-limited JSON string. Reads are not audited by default, though ordinary logs may include diagnostics.

## Implementation Modules

- MCP transport/server adapter
- OPC UA gateway behind an `OpcUaGateway` interface
- config loader and Zod schema validator
- policy/allowlist evaluator
- control confirmation token store
- audit logger behind an `AuditSink` interface
- admin CLI

## Testing Strategy

Tests use both mock boundaries and optional real OPC UA integration.

Unit tests mock the `OpcUaGateway` interface for policy, read scope, control confirmation, write verification, and failure behavior. Unit tests use an in-memory `AuditSink` and failing `AuditSink` to verify audit behavior and fail-closed control semantics.

Config validation is split into mostly pure functions:

- `loadConfigFile(path)` reads YAML and performs environment interpolation
- `parseConfig(raw)` applies the strict Zod schema
- `validateLocalConfig(config)` applies pure safety rules
- `validateOnlineConfig(config, gateway)` checks NodeIds, datatypes, readability, and writability through OPC UA

Contract tests verify representative MCP tool input/output schemas and result shapes with focused assertions plus a few golden examples.

No demo OPC UA server is required for v1 because development targets an existing local OPC UA Server. Real OPC UA integration tests are opt-in via environment variables so normal test runs and CI do not require a server.

Suggested integration-test environment variables:

- `OPCUA_TEST_ENDPOINT`
- `OPCUA_TEST_USERNAME` / `OPCUA_TEST_PASSWORD` if needed
- `OPCUA_TEST_READ_NODE_ID`
- `OPCUA_TEST_WRITE_NODE_ID`
- `OPCUA_TEST_WRITE_VALUE`
- `OPCUA_TEST_ENABLE_WRITES=true`

Integration write tests are skipped unless `OPCUA_TEST_ENABLE_WRITES=true` and a safe write NodeId/value are provided. Examples and test docs warn that write tests must use simulator, test, or otherwise safe nodes approved by an Operator.
