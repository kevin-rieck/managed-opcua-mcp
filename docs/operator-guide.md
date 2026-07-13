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

## Commissioning workflow

Commission a new config in stages. Keep the source and generated files out of version control if they contain site details, and perform initial work against a simulator, test system, or otherwise safe OPC UA Server approved by an Operator.

### 1. Create and locally validate the initial config

Configure the connection and audit sink first. Add known Read Entry Points if available, but omit `controls` or keep `controls.enabled: false` during commissioning.

```bash
npm run dev -- validate --config opcua-mcp.local.yaml
```

`validate` checks YAML, schema, secret references, config hashing, Read Entry Points, Control Catalog safety rules, and audit shape. It performs **no OPC UA network I/O**. A successful local validation means only that the file is internally valid; it does not prove that the endpoint is reachable or that configured Nodes exist.

`validate-config` remains as a deprecated compatibility spelling. Its `--online` option is retained for compatibility, but new workflows should use `doctor`:

```bash
npm run dev -- validate-config --config opcua-mcp.local.yaml --online
```

### 2. Run online diagnostics

When the OPC UA Server is reachable and the intended credentials are available, inspect the configured Read Entry Points and Control Catalog:

```bash
npm run dev -- doctor --config opcua-mcp.local.yaml --format json
```

`doctor` first performs the same local validation and then connects to the OPC UA Server. It reports Node availability and browseability for Read Entry Points. For configured Semantic Controls, it checks target existence, scalar shape, data type compatibility, and advisory session write access. These checks read metadata, not current process values, and perform no Control Operation.

Interpret `doctor` results as follows:

| Result class                     | Exit | Meaning                                                                                                                                         |
| -------------------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                        |    0 | Local validation and online diagnostics passed with no commissioning warnings.                                                                  |
| `commissioning_warnings`         |    0 | Online checks passed, but Operator review is still required; for example, configured controls are disabled.                                     |
| `local_validation_failed`        |    1 | The config is malformed or violates local schema or safety rules.                                                                               |
| `online_blocking_errors`         |    3 | A configured Node is missing or unsuitable, authorization prevented a required check, or another online check failed. Do not serve this config. |
| `online_diagnostics_unavailable` |    4 | Diagnostics did not complete before the online timeout. Reachability and readiness remain unknown.                                              |
| `strict_warning_failure`         |    5 | Warnings were found while `--strict-warnings` was requested.                                                                                    |

A commissioning warning is not the same as a validation failure. It records something an Operator must review or accept. An online blocking error means the config is not ready to serve. Use `--strict-warnings` in automation when warnings must also produce a non-zero exit.

### 3. Run bounded discovery and setup

`setup` combines local validation, bounded metadata-only discovery, online diagnostics, and generation of an Operator-review draft config and Markdown report:

```bash
npm run dev -- setup \
  --config opcua-mcp.local.yaml \
  --out opcua-mcp.draft.local.yaml \
  --report commissioning-report.local.md
```

By default, discovery starts at the configured Read Entry Points, traverses only forward hierarchical references, stops at depth 4 or 1,000 visited Nodes, and records partial coverage and access failures. If no Read Entry Points are configured, or a narrower inspection is desired, provide one or more explicit roots:

```bash
npm run dev -- setup \
  --config opcua-mcp.local.yaml \
  --root 'ns=2;s=Machine' \
  --root 'ns=2;s=Utilities' \
  --depth 3 \
  --max-nodes 500 \
  --out opcua-mcp.draft.local.yaml \
  --report commissioning-report.local.md
```

Discovery inspects identity, hierarchy, data type, access, engineering-unit, range, and enum metadata where available. It does **not** read current values, subscribe, write values, call methods, or otherwise perform a Control Operation. OPC UA Server authorization remains authoritative; a discovered Node or apparent write-access bit does not grant permission.

`setup` refuses to overwrite either output unless `--force` is supplied. Use `--dry-run` to run checks and preview the selected paths without writing files. The command still writes review outputs when discovery is partial or online checks find blocking errors, so inspect its JSON result and exit code rather than treating file creation as success. Setup uses the same online exit meanings (`3` for blocking errors and `4` for unavailable diagnostics).

### 4. Review the report and promote drafts explicitly

The generated report is a review artifact, not approval to serve. Review each section:

1. **Summary** — endpoint redaction mode, discovery coverage, finding counts, and recommendation.
2. **Blocking errors** — conditions that must be resolved before serving.
3. **Warnings** — partial or advisory findings that must be resolved or explicitly accepted by an Operator.
4. **Required Operator decisions** — the checklist for Read Entry Points, incomplete roots, candidates, constraints, and omitted writable Nodes.
5. **Suggested Read Entry Points** — navigation suggestions only, never authorization boundaries.
6. **Draft Semantic Control candidates** — metadata-derived starting points for review.
7. **Writable but not suggested** — Nodes that should normally remain outside the Control Catalog unless deliberately reviewed.
8. **Discovery coverage and evidence** — per-root status, limits reached, and metadata success or failure.
9. **Redaction and sensitive-data note** — what the report omits.
10. **Setup online diagnostics** — checks against the configured Read Entry Points and Control Catalog.

Generated Semantic Control candidates are comments in the draft config and are **not executable**. Setup never merges them into `controls.items`. For every candidate, an Operator must either reject it or manually promote it into the Control Catalog after confirming:

- final name, description, target Node, and intended process meaning;
- supported scalar data type and OPC UA Server authorization;
- unit, numeric bounds, Boolean labels, or allowed values as applicable;
- Operator-owned Risk Level and Risk Note;
- cooldown and whether current-value confirmation is required.

Discovered engineering ranges and write-access metadata are advisory, not safe operating limits or authorization. Keep promoted controls disabled with `controls.enabled: false` until review and diagnostics are complete. High-risk controls remain unsupported in v1, and medium-risk controls require Control Confirmation when used by an Agent.

Reports redact the endpoint by default because it can reveal network or plant topology. They omit passwords, tokens, usernames, private-key material, environment secret references, and current OPC UA values. Evidence includes sanitized sources and OPC UA statuses. NodeIds and display names may still reveal process topology, so protect reports as site-sensitive operational records.

### 5. Revalidate the reviewed draft, then serve

After editing the generated draft and promoting or rejecting every candidate, repeat both checks against the draft file:

```bash
npm run dev -- validate --config opcua-mcp.draft.local.yaml
npm run dev -- doctor --config opcua-mcp.draft.local.yaml --format json --strict-warnings
```

Resolve all blocking errors. Resolve or consciously accept warnings, verify every Read Entry Point and Semantic Control, and obtain any site-required review outside the MCP Server. Only then enable approved controls and start the stdio MCP Server:

```bash
npm run dev -- serve --config opcua-mcp.draft.local.yaml
```

Read Entry Points still do not create a read authorization boundary, and the Control Catalog does not replace OPC UA Server authorization. Start with simulator, test, or otherwise safe controls. Review audit records after test Control Attempts, verify Control Confirmation behavior for medium-risk controls, and confirm Write Verification results before broader use.

## Real OPC UA integration tests

Real OPC UA integration tests are opt-in. They are skipped unless endpoint environment variables such as `OPCUA_TEST_ENDPOINT` are set.

Real write integration tests require stronger precautions and are skipped unless all write-test guards are set, including `OPCUA_TEST_ENABLE_WRITES=true`, a safe write NodeId, and a safe value.

Only run write integration tests against simulator, test, or otherwise safe Nodes approved by an Operator. Never point write tests at production equipment unless your site has explicitly approved the exact Node, values, timing, and rollback process.
