# Managed OPC UA MCP Server

A TypeScript MCP server that exposes OPC UA read access through server-side authorization and Operator-defined Semantic Controls for safe agent interaction.

See [`docs/plan.md`](./docs/plan.md), [`docs/operator-guide.md`](./docs/operator-guide.md), and [`CONTEXT.md`](./CONTEXT.md).

## Security posture

- No arbitrary OPC UA writes.
- Reads rely on OPC UA Server credentials and roles for authorization.
- Optional Read Entry Points guide agent discovery.
- Writes use Operator-defined Semantic Controls only.
- High-risk controls are rejected in v1.
- Control attempts are audited.
- Secrets must be provided through environment variables, not literal YAML values.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Local use

Read the [Operator safety guide](./docs/operator-guide.md) before enabling controls.

Copy `examples/local.config.yaml` to a non-committed local config and edit it for your OPC UA server.

```bash
cp examples/local.config.yaml opcua-mcp.local.yaml
npm run dev -- serve --config opcua-mcp.local.yaml
```

Write examples and integration write tests must only target simulator, test, or otherwise safe nodes approved by an Operator.
