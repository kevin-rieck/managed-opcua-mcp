# Product requirements: OPC UA-native MCP

The current v2 checkout provides a local stdio MCP Server connecting to one OPC UA Server with one configured session identity. OPC UA Server authorization governs browsing, reading and writing. Read Entry Points guide navigation, not access. Operators need a dedicated least-privilege principal, including verified anonymous denial for read-only deployments. No independent per-Agent identity or human approval is implied.

## Capabilities

- Browse (`browse_node`) and read (`read_node`, `read_nodes`) return raw values, including booleans and enum representations, with operation status and quality rather than catalog labels.
- `write_node` is registered unconditionally and writes only Value with an explicit bounded supported scalar encoding. It makes no metadata or read prerequisite and no automatic readback or retry. Server acceptance is not physical success or safety.
- Mandatory append-only write audit records intent before dispatch and independently reports completion audit failure and known/unknown mutation outcome. Protect values and targets in the audit file; append is neither fsync nor an OPC UA transaction.
- Strict v2 config, environment secret references, explicit certificate trust, redacted resources, local validation and online root diagnostics support operation. See [operator guide](operator-guide.md).

The old four catalog tools and `setup` / `discover-controls` are retired without replacement. No approvals, catalog policy, site safety limits, arrays, methods, subscriptions, history, HTTP or delegated identities are supplied. The [native inspection specification](specs/opcua-native-inspection.md) is a separate, unimplemented read-only slice; its source-trust and no-write-audit requirements remain intact and are not acceptance claims here.

See [ADR 0003](adr/0003-native-writes-with-server-authorization.md), the [write contract](specs/opcua-native-write-v2.md), and [migration acceptance evidence](opcua-native-migration-acceptance.md). Final release review remains pending.
