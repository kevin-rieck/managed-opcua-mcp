# Constrain agent control with Semantic Controls

Status: Partially superseded by ADR 0002.

ADR 0002 replaces the configured Read Scope and allowlist authorization framing with OPC UA Server authorization, Read Entry Points, and a Control Catalog. This ADR remains valid for the decision to expose writes only through Semantic Controls rather than arbitrary raw NodeId writes.

The OPC UA MCP Server exposes agent control through Operator-defined Semantic Controls rather than arbitrary OPC UA writes. v1 targets local stdio operation, rejects high-risk controls, audits all Control Attempts, and favors safety, auditability, and Operator intent over full generic control access to the OPC UA address space.
