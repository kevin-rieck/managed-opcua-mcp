# Rely on OPC UA Server authorization and simplify MCP configuration

The MCP Server will rely on OPC UA Server credentials and roles as the authorization boundary for reads and underlying writes, instead of duplicating detailed read/write permissions in MCP configuration. MCP configuration will provide Read Entry Points for agent navigation, and writes will still be exposed only through Operator-defined Semantic Controls in a Control Catalog so the agent-facing interface retains names, validation rules, risk context, confirmation, and audit semantics. This trades MCP-side read defense-in-depth for a smaller configuration surface, clearer ownership of access rights, and easier adoption.

## Consequences

- Read configuration is guidance for discovery, not an authorization boundary.
- `server.mode` is removed; the Control Surface exists when Semantic Controls are configured.
- `controls.enabled` remains as an optional operational switch and defaults to enabled when controls are configured.
- The old Allowlist and Read Scope language should be retired in favor of Control Catalog and Read Entry Points.
