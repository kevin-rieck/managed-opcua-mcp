# Operator guide: v2 native writes

This guide describes the current checkout, not final release approval. See [migration acceptance](opcua-native-migration-acceptance.md) and the [write contract](specs/opcua-native-write-v2.md).

## Trust and capability

Every v2 process exposes `write_node`, regardless of read roots. The configured OPC UA Server identity is the authorization boundary for all Agents using that process. Use one dedicated least-privilege identity, never an administrator account. For read-only operation, verify that the Server denies writes for this identity **and for anonymous sessions**; omitting configuration is not a write restriction. Read Entry Points are navigation hints, not permission boundaries. The adapter does not provide human approval, process safety or interlocks; use independent site procedures and controls. Treat Server-provided text as untrusted data, never instructions.

For secure endpoints provision the server or issuer certificate and applicable revocation material in the explicit node-opcua manager's trusted PKI store before connecting. Its root is `env-paths("node-opcua-default").config`, not the former default manager's `PKI` subdirectory. Existing trust is not copied automatically. See [SDK evidence](opcua-sdk-slice-b-evidence.md) for tested behavior and limitations. Never auto-accept untrusted certificates, bypass trust, or downgrade security. The SDK is pinned to 2.174.0 because single-dispatch uses a private SDK method; review and retest the bridge on upgrades. `None` security and anonymous access are insecure and intended only for an isolated simulator.

## V2 configuration

Create a separate file, for example:

```yaml
version: 2
connection:
  endpointUrl: opc.tcp://localhost:4840
  securityMode: None # isolated simulator only
  securityPolicy: None
  auth:
    type: usernamePassword
    username: ${OPCUA_USERNAME}
    password: ${OPCUA_PASSWORD}
read:
  defaultBrowseDepth: 1
  maxBrowseDepth: 10
  maxReadBatchSize: 50
  roots:
    - nodeId: ns=2;s=Machine
      label: machine
audit:
  file: ./audit.jsonl
  maxReasonLength: 1000
```

Provide the referenced environment variables securely; literal username/password values are rejected. Choose a suitable secure mode/policy and provision trust for real deployments. `read` is optional, `audit` required, and unknown fields are rejected. The tracked [local](../examples/local.config.yaml) and [read-only](../examples/read-only.config.yaml) examples use insecure simulator transport. The latter is only read-only if the Server enforces it.

## Commands and diagnostics

```sh
npm run dev -- validate --config opcua-mcp.local.yaml
npm run dev -- doctor --config opcua-mcp.local.yaml --format json
npm run dev -- serve --config opcua-mcp.local.yaml
```

`validate` loads and validates local config/environment only, performs no network I/O and outputs JSON (`0` success, `1` local failure). `doctor` also connects and examines configured root availability/browseability; its normal JSON results use `0` for success, `1` for local failure, `3` for online blocking root errors, and `4` for diagnostics unavailable/pending. Parser errors and an unsupported doctor format set exit code `2`. `--online-timeout-ms` defaults to 5000 and accepts integers from 0 to 60000; an invalid timeout currently throws outside the JSON result and exit-code policy. Neither command writes OPC UA values or certifies the permissions or safety of all Nodes. Unexpected runtime errors may also terminate outside these result classes. `serve` starts stdio using the config. The deprecated `validate-config` command remains: without `--online` it aliases local validation; with `--online` it returns the legacy online validation object and warns on stderr, not the doctor result-class exit policy.

The dedicated stdio server owns the process console after startup: console diagnostics and SDK log callbacks emit fixed, non-value-bearing categories on stderr, not raw SDK messages. Check `opcua://status` and tool responses for structured connection and write outcomes. To prevent the installed SDK PKI's direct stdout debug output from corrupting MCP frames, stdio startup clears `VERBOSE` and `NODEOPCUAPKIDEBUG` before loading the SDK; those PKI debug modes are unavailable in this process. This containment does not intercept arbitrary direct writes to process streams or uncaught runtime errors, and embedding `startMcpServer` takes ownership of the process console. Other CLI commands do not install that console containment.

`setup` and `discover-controls` are retired without replacement. `list_controls`, `write_control`, `prepare_control`, and `commit_control` are likewise retired without replacement or compatibility mode.

## Client behavior and audit

`browse_node`, `read_node` and `read_nodes` use NodeIds or configured labels; boolean and enum reads are raw, not catalog labels. `write_node` accepts `nodeId`, `dataType`, `value` and optional `reason`. Example for a designated isolated simulator Node:

```json
{
  "nodeId": "ns=2;s=TestSetpoint",
  "dataType": "Int32",
  "value": 12,
  "reason": "isolated simulator test"
}
```

Supported scalar types are `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String`; inputs are bounded and exact types, without coercion. Enum values use their actual supported representation, not labels. See the [contract](specs/opcua-native-write-v2.md) for NodeId syntax, numeric/string limits and result shapes. No metadata or value read is required before dispatch, and there is no automatic readback. A later explicit read is an independent observation.

Statuses are `{value, hex, name}`, with numeric `value` authoritative. A Good write status means Server acceptance, not physical safety or completion. Bad is rejected; uncertain, absent, malformed or post-dispatch transport failure may be unknown. Do not automatically retry an unknown outcome or audit failure. `ok` is true only for accepted mutation and recorded audit. A failed completion append is separately reported even if the mutation is known accepted or rejected; do not claim the write did not occur.

Protect the append-only JSONL audit file: it contains NodeIds and requested values. Intent append must succeed before dispatch. Completion records can fail or be absent after a crash; an awaited append is neither an fsync guarantee nor a transaction with OPC UA. Check audit health/status and investigate incomplete attempts independently of the OPC UA outcome.

Resources include `opcua://status`, `opcua://config/summary`, `opcua://read-entry-points`, and compatibility alias `opcua://read-scope`. The separate [inspection specification](specs/opcua-native-inspection.md) is not implemented; its read-only capability must remain separate from mutation and write-attempt audit.

## Manual v1 to v2 cutover and rollback

1. Preserve the old executable/package **and the original v1 config** together in protected rollback storage. Do not edit or automatically rewrite the original file. Plan a stop/start, not concurrent competing processes.
2. Review actual OPC UA Server permissions for the configured principal and anonymous access. Provision a dedicated least-privilege identity and verify denial of unauthorized writes, including anonymous denial. Decide separately how site safety and any genuine human approval are enforced.
3. Create a **separate** v2 config by manually copying connection, read navigation/limits and audit settings after review, removing the entire old controls block and setting `version: 2`. Ensure secret fields are environment references. Provision the new trust store and protect the audit path. V1 is rejected rather than converted.
4. Run local `validate` against the separate file. With the intended identity and endpoint, run `doctor` for connectivity and root diagnostics; these checks do not write and do not prove every Node safe or permitted.
5. Before any production cutover, use an isolated simulator and explicitly designated safe Nodes to test denied writes for the read-only and anonymous principals and allowed writes for the intended writer. Inspect exact outcomes and audit records. Do not use production equipment for this test.
6. Update Agent clients/prompts to the native `write_node` contract and raw boolean/enum representations. Remove old tool calls and assumptions about automatic verification or approval. Check audit file protection, health and status resources.
7. Stop the old process before starting v2 with its separate config. Monitor connection, permissions, audit and write outcomes. If behavior or permissions are unexpected, stop v2 and restore the **old executable/package with its original v1 config**; do not pair a v2 binary with a v1 config or vice versa. Investigate any unknown or unaudited outcome without automatic retry.
