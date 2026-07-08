# Managed OPC UA MCP Server

This context describes an MCP adapter that lets agents inspect and operate an OPC UA server.

## Language

**OPC UA Server**:
An industrial data and control endpoint that exposes an OPC UA address space.
_Avoid_: opc ua server, plant server

**MCP Server**:
The adapter that exposes selected OPC UA capabilities to agents through the Model Context Protocol.
_Avoid_: bridge, proxy

**Agent**:
An MCP client that requests inspection or control operations through the MCP Server.
_Avoid_: bot, user

**Node**:
An entity in an OPC UA Server address space, identified by a NodeId.
_Avoid_: resource, item

**Control Operation**:
An operation that can change state in the OPC UA Server, such as writing a value or calling a method.
_Avoid_: write, command

**Control Surface**:
The MCP tools exposed for listing, preparing, committing, and performing Semantic Controls.
_Avoid_: control mode, write access

**Control Catalog**:
The Operator-defined collection of Semantic Controls exposed by the MCP Server. The Control Catalog shapes the agent-facing control interface but does not replace OPC UA Server authorization.
_Avoid_: allowlist, permissions, access list, whitelist

**Read Entry Point**:
An Operator-provided starting Node for agent browsing and discovery in an OPC UA Server address space. Read Entry Points guide navigation but are not an authorization boundary; read access is enforced by the OPC UA Server.
_Avoid_: read permissions, read scope, visible nodes

**Semantic Control**:
An Operator-defined Control Operation exposed to agents by name, backed by a specific OPC UA NodeId, validation rules, and safety context. Authorization for the underlying OPC UA write is enforced by the OPC UA Server.
_Avoid_: raw write, command

**Operator**:
A person responsible for approving which OPC UA controls and read scopes the MCP Server exposes to agents.
_Avoid_: admin, owner

**Risk Level**:
An Operator-assigned classification of the potential consequence of a Semantic Control.
_Avoid_: severity, danger level

**Risk Note**:
An Operator-written description of the consequence or caution associated with a Semantic Control.
_Avoid_: warning, description

**Control Confirmation**:
A deliberate two-step interaction that requires an agent to prepare and then commit a medium-risk Semantic Control before the MCP Server performs it.
_Avoid_: human approval, approval

**Control Attempt**:
A request to prepare or perform a Semantic Control, whether it succeeds or fails.
_Avoid_: write attempt, command attempt

**Write Verification**:
A post-write check that compares the requested value with the value observed from the OPC UA Server.
_Avoid_: success check, confirmation
