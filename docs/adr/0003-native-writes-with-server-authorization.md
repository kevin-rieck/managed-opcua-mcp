# Expose native writes under OPC UA Server authorization

Status: Accepted and implemented in the current v2 checkout; release acceptance remains pending.

The MCP Server will expose bounded native Value-attribute writes by NodeId using its configured OPC UA session identity, rather than requiring a second Operator-defined Control Catalog. OPC UA Server roles remain the authorization boundary; the adapter retains mandatory fail-closed pre-write audit and honest outcome reporting. This removes duplicated configuration but expands the Agent-facing capability: deployments must review account permissions, and neither server authorization nor metadata establishes process safety. The old catalog, confirmations, and commissioning workflow are retired, not offered as a compatibility mode; human approval, where needed, belongs outside this adapter. ADR 0001 and the retained-catalog portions of ADR 0002 are superseded; their historical reasoning remains recorded.
