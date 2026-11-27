# Implementation plan: native OPC UA operations

The current checkout implements the v2 native-write direction in [ADR 0003](adr/0003-native-writes-with-server-authorization.md). The [migration plan](opcua-native-migration-plan.md) preserves the approved scope and acceptance matrix; the [acceptance record](opcua-native-migration-acceptance.md) tracks evidence and outstanding release checks. This is not a final release approval.

## Current boundary

Strict configuration v2 has connection, optional read navigation and mandatory audit. One OPC UA identity provides server-enforced authorization. `browse_node`, `read_node`, and `read_nodes` expose native values; `write_node` is always present for bounded scalar Value writes. Read roots are not permissions. Write acceptance is not physical safety, no read is required before or after a write, and unknown outcomes must not be automatically retried. Append-only audit is mandatory but not transactional or fsync-backed. A dedicated least-privilege identity and external site safety/approval controls are required.

`list_controls`, `write_control`, `prepare_control`, `commit_control`, `setup`, and `discover-controls` are retired without replacement. Use the manual [operator cutover and rollback](operator-guide.md), not automatic conversion. `validate`, `doctor`, `serve`, deprecated `validate-config`, and the read-scope resource alias remain.

The [native inspection specification](specs/opcua-native-inspection.md) is separate and not implemented: do not claim its acceptance. Server-provided text is untrusted, and future read-only inspection remains separate from mutation and write-attempt audit. Full local checks and independent review are still required before release. SDK pin, trust path and limited protocol evidence are documented in [SDK evidence](opcua-sdk-slice-b-evidence.md).
