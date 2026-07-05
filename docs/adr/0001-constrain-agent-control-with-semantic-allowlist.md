# Constrain agent control with a semantic allowlist

The OPC UA MCP Server exposes agent control through Operator-approved Semantic Controls rather than arbitrary OPC UA writes. v1 targets local stdio operation, scopes reads through configured Read Scopes, rejects high-risk controls, supports a read-only deployment mode with no control tools, and audits all Control Attempts. This favors safety, auditability, and Operator intent over full generic access to the OPC UA address space.
