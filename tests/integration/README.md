# OPC UA integration tests

The default test suite includes `isolated-opcua-protocol.test.ts`, an in-process loopback simulator with temporary PKI and isolated test identities. It exercises selected real protocol write permissions, status, reconnect and secure trust paths; see [SDK evidence](../../docs/opcua-sdk-slice-b-evidence.md) for exact coverage and limits. No external endpoint is needed for that test.

`real-opcua.test.ts` is separately opt-in and skips without `OPCUA_TEST_ENDPOINT`. Optional `OPCUA_TEST_SECURITY_MODE` and `OPCUA_TEST_SECURITY_POLICY` default to `None`; set both `OPCUA_TEST_USERNAME` and `OPCUA_TEST_PASSWORD` for username/password. For a read also set `OPCUA_TEST_READ_NODE_ID`. Secure endpoints require explicit trust provisioning as described in the [operator guide](../../docs/operator-guide.md).

A real write additionally requires all of `OPCUA_TEST_ENABLE_WRITES=true`, `OPCUA_TEST_WRITE_NODE_ID`, and `OPCUA_TEST_WRITE_VALUE`; `OPCUA_TEST_WRITE_DATA_TYPE` defaults to `String`. **Only use an isolated simulator or explicitly designated safe test Node and value. Never run write tests against production controls or unsafe equipment.** This flag is not human approval or a safety guarantee. Good means Server acceptance, not physical safety.
