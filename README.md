# Managed OPC UA MCP Server

A local stdio MCP Server for browsing, reading and bounded native Value writes to one OPC UA Server using one configured session identity. Version 0.2.0 is a breaking tool, configuration and audit boundary; see [release notes](docs/release-notes-0.2.0.md) and the [operator cutover guide](docs/operator-guide.md). Final release acceptance is pending.

**`write_node` is always exposed**, including for an empty read configuration. The OPC UA Server must deny writes to a read-only identity; configuration and Read Entry Points are not authorization boundaries. Use a dedicated least-privilege identity and verify anonymous access is also denied where appropriate. Server acceptance is not proof of process safety or physical completion. No human approval is provided by this adapter.

## Quick start

Requires Node.js 22+ and npm 10+. Install dependencies with `npm ci`. Copy `examples/local.config.yaml` to a separate local file for an isolated simulator only: its `None` security and anonymous identity are insecure. For username/password use environment references as in `examples/read-only.config.yaml`, not literal credentials. Provision trust before using a secure endpoint; see the operator guide.

```sh
npm run dev -- validate --config opcua-mcp.local.yaml
npm run dev -- doctor --config opcua-mcp.local.yaml
npm run dev -- serve --config opcua-mcp.local.yaml
```

`validate` is offline; `doctor` connects and checks configured read roots. Neither writes or certifies permissions or safety for all Nodes. `serve` uses stdio. The deprecated `validate-config` alias remains; `--online` enables its older online behavior.

## Interface

- `browse_node`, `read_node`, `read_nodes`: browse and read with raw boolean/enum values. Read Entry Points are navigation only.
- `write_node(nodeId, dataType, value, reason?)`: single Value write using an explicit supported scalar type; no read prerequisite, automatic readback or retry. See the [write contract](docs/specs/opcua-native-write-v2.md) for exact bounds, statuses, response and audit records.
- Resources: `opcua://status`, `opcua://config/summary`, `opcua://read-entry-points`, and the compatibility alias `opcua://read-scope`.

The four former tools `list_controls`, `write_control`, `prepare_control`, and `commit_control` and both `setup` and `discover-controls` commands are retired **without replacement**. `write_node` is a different native interface, not a compatibility replacement. The separately specified [native inspection](docs/specs/opcua-native-inspection.md) is not implemented or accepted as part of this migration.

Run `npm run check` and `npm run build` for local checks. The default test suite includes an isolated loopback protocol simulator. External endpoint tests are opt-in; see [integration tests](tests/integration/README.md). Do not connect to production for testing.
