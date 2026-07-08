# Operator safety guide

This guide explains how Operators can configure and run the OPC UA MCP Server safely. It uses the project language from [`CONTEXT.md`](../CONTEXT.md): OPC UA Server, MCP Server, Agent, Read Entry Point, Control Catalog, Semantic Control, Risk Level, Risk Note, Control Confirmation, Control Attempt, and Write Verification.

For the safety rationale, read:

- [ADR 0001: Constrain agent control with Semantic Controls](./adr/0001-constrain-agent-control-with-semantic-allowlist.md)
- [ADR 0002: Rely on OPC UA Server authorization and simplify MCP configuration](./adr/0002-rely-on-opc-ua-server-authorization-and-simplify-mcp-configuration.md)

## Safety model

The MCP Server does not replace the OPC UA Server's security model. OPC UA Server credentials and roles remain the authorization boundary for reads and for the underlying writes performed by Semantic Controls.

The MCP Server adds an Operator-designed agent-facing surface:

- Read Entry Points guide discovery but do not grant access.
- Browse and read tools may attempt requested NodeIds, and the OPC UA Server decides whether those reads are authorized.
- Agents cannot write arbitrary raw NodeIds.
- Control Operations are exposed only as Operator-defined Semantic Controls in the Control Catalog.
- High-risk Semantic Controls are rejected in v1.
- Medium-risk Semantic Controls require Control Confirmation.
- Control Attempts are audited, and control writes fail closed when audit logging is unavailable.

## `server.mode` and `controls.enabled`

Older drafts used `server.mode` to choose read-only versus control-capable operation. v1 does not accept `server.mode`.

In v1, the Control Surface exists when `controls.items` are configured. Use `controls.enabled` only as an operational commissioning switch:

```yaml
controls:
  enabled: false
  items:
    - name: set_motor_speed
      # ...
```

- Omit `controls.enabled` or set it to `true` when configured controls should be executable.
- Set `controls.enabled: false` to keep controls visible through `list_controls()` but unavailable for execution.
- Changing `controls.enabled` requires restarting the MCP Server in v1.

## Read Entry Points and read limits

Configure optional Read Entry Points under `read.roots`:

```yaml
read:
  defaultBrowseDepth: 1
  maxBrowseDepth: 10
  maxReadBatchSize: 50
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
      description: Main machine address space.
```

Read Entry Point fields:

- `nodeId`: OPC UA NodeId where an Agent can begin browsing.
- `label`: optional globally unique snake_case shortcut for `browse_node(label: ...)`.
- `description`: Operator-facing context shown to Agents.

Read limits:

- `defaultBrowseDepth` bounds default browse traversal.
- `maxBrowseDepth` caps Agent-requested browse depth.
- `maxReadBatchSize` caps `read_nodes` batch size.

Important: v1 does not have MCP-side Read Scope authorization. There is no `read.nodes` explicit allowlist and no `read.exclude` exclusion list. If you are migrating from an old draft config, remove explicit read Nodes and exclusions, then rely on OPC UA Server credentials and roles for authorization.

## Semantic Controls

Semantic Controls are the only way Agents can request Control Operations. Each Semantic Control must explain what it does and how values are constrained.

Typical control:

```yaml
controls:
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

Required safety context:

- `name`: globally unique snake_case control name.
- `description`: clear Operator-written purpose.
- `riskLevel`: `low` or `medium` in v1.
- `riskNote`: consequence or caution the Agent must see.
- `nodeId`: target Node for the underlying OPC UA write.
- `dataType`: supported OPC UA built-in data type.

Value constraints:

- Numeric controls require finite inclusive `min`, `max`, and `unit`.
- Boolean controls require `falseLabel` and `trueLabel`.
- String and enum-like controls require ordered `allowedValues`.
- `Int64`, `UInt64`, complex values, arrays, ExtensionObjects, and structures are out of scope for v1.

Cooldowns:

- `controls.defaults.cooldownMs` sets a default delay between writes.
- Per-control `cooldownMs` overrides the default.
- Cooldown is enforced at write or commit time so Agent loops cannot rapidly oscillate equipment state.

High-risk controls:

- `riskLevel: high` is rejected in v1.
- Do not configure dangerous physical operations until the project explicitly supports them and your site has approved the safety process.

## Control Confirmation

Low-risk controls may be executed with `write_control(controlName, value, reason?)`.

Medium-risk controls require a deliberate two-step API:

1. `prepare_control(controlName, value, reason)` validates the value, records a preparation audit entry, returns risk context, and issues a short-lived opaque token.
2. `commit_control(token)` rechecks token validity, connection generation, audit health, cooldown, availability, and OPC UA authorization before writing.

Control Confirmation is not proof of human approval. It only proves the Agent used the two-step API. If your site requires human approval, enforce that outside the MCP Server process and include the approval reference in the `reason` text.

## Audit behavior

The MCP Server writes append-only JSON Lines audit records for Control Attempts, including preparation attempts, commits, direct writes, rejections, OPC UA errors, and verification outcomes.

Audit records include operational context such as timestamp, control name, target NodeId, requested value, Risk Level, reason, non-secret config hash, OPC UA status when available, and error fields.

Control writes fail closed when audit logging is unavailable. In practice:

- If the audit file cannot be opened or written, `write_control`, `prepare_control`, and `commit_control` reject before OPC UA writes.
- Do not place the audit file on volatile or unreliable storage for production-like use.
- Protect audit logs according to your site incident-response and retention policy.

## Secrets and environment variables

Do not put passwords, tokens, certificates, private keys, or other secrets directly in YAML config. v1 rejects literal secrets in secret fields. Use environment variable references instead.

Example pattern:

```yaml
connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: SignAndEncrypt
  securityPolicy: Basic256Sha256
  auth:
    type: usernamePassword
    username: operator_runtime
    password:
      env: OPCUA_PASSWORD
```

Operational rules:

- Keep local config files out of version control.
- Set secret environment variables in your shell, service manager, or secret manager before starting the MCP Server.
- Config summaries, CLI output, logs, and MCP resources redact secrets and secret references.

## Safe local usage

Start from the example config:

```bash
cp examples/local.config.yaml opcua-mcp.local.yaml
```

Edit `opcua-mcp.local.yaml` for your OPC UA Server endpoint, credentials, Read Entry Points, audit file, and any Semantic Controls. Keep `*.local.yaml` uncommitted.

Validate config before running:

```bash
npm run dev -- validate-config --config opcua-mcp.local.yaml
```

Run optional online validation when the OPC UA Server is reachable:

```bash
npm run dev -- validate-config --config opcua-mcp.local.yaml --online
```

Run the local stdio MCP Server:

```bash
npm run dev -- serve --config opcua-mcp.local.yaml
```

Recommended commissioning sequence:

1. Configure connection and audit first, with no controls.
2. Add Read Entry Points and validate browsing with read-only tools.
3. Draft Semantic Controls with `controls.enabled: false`.
4. Validate locally and online.
5. Have an Operator review every description, Risk Level, Risk Note, value constraint, and cooldown.
6. Enable only simulator, test, or otherwise safe controls first.
7. Review audit records after test Control Attempts.

## Real OPC UA integration tests

Real OPC UA integration tests are opt-in. They are skipped unless endpoint environment variables such as `OPCUA_TEST_ENDPOINT` are set.

Real write integration tests require stronger precautions and are skipped unless all write-test guards are set, including `OPCUA_TEST_ENABLE_WRITES=true`, a safe write NodeId, and a safe value.

Only run write integration tests against simulator, test, or otherwise safe Nodes approved by an Operator. Never point write tests at production equipment unless your site has explicitly approved the exact Node, values, timing, and rollback process.
