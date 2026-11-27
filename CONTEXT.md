# Managed OPC UA MCP Server

This context describes the native-write v2 domain in the current checkout. The separate native inspection specification remains a target, not an implemented capability.

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

**Read Entry Point**:
An Operator-provided starting Node for agent browsing and discovery in an OPC UA Server address space. Read Entry Points guide navigation but are not an authorization boundary; read access is enforced by the OPC UA Server.
_Avoid_: read permissions, read scope, visible nodes

**Operator**:
A person responsible for configuring the MCP Server and the OPC UA identity used by Agents.
_Avoid_: admin, owner

**Write Attempt**:
An Agent request to write a Node's Value, including requests rejected before dispatch.
_Avoid_: Control Attempt

**Write Outcome**:
What is known about whether the OPC UA Server accepted or rejected a dispatched write, independently of whether its audit record was appended.
_Avoid_: physical success, verification
