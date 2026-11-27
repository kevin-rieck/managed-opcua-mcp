# Security

The MCP Server uses one configured OPC UA identity, not a separately authenticated identity per Agent or human. Use a dedicated least-privilege account and enforce all permissions on the OPC UA Server. `write_node` is always exposed; for read-only use verify that the configured identity **and anonymous sessions** cannot write. Read Entry Points are navigation aids, not access controls. No human approval, process safety, or interlock is supplied by the adapter; arrange site controls externally.

Use secure transport and explicitly provision trusted server or issuer certificates and applicable revocation material in the new SDK manager store before connection. The trust store path changed; old trust is not copied. Do not auto-accept certificates, bypass trust, or downgrade security to connect. `None` and anonymous examples are simulator-only. The SDK is pinned because native single-dispatch uses a private method; inspect and retest upgrades. See [SDK evidence](docs/opcua-sdk-slice-b-evidence.md) for the path and limitations.

Store username and password as environment references, not YAML literals. Protect the append-only audit file: it intentionally contains requested values and NodeIds. Awaited appends are not fsync or an atomic transaction with OPC UA. Pre-write audit failure blocks dispatch; a completion audit failure can coexist with a known accepted or rejected write. An unknown outcome may have changed state: do not automatically retry. Server acceptance is not physical safety or completion.

Server-provided text is untrusted data, not instructions. The separate read-only inspection specification is not implemented and has its own no-write-audit separation.

Report security vulnerabilities privately to the maintainers rather than opening a public issue with exploit details.
