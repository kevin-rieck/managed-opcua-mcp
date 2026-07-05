# Optional OPC UA integration tests

Real OPC UA integration tests are opt-in and must not write unless explicitly enabled.

Required for read tests:

- `OPCUA_TEST_ENDPOINT`
- `OPCUA_TEST_READ_NODE_ID`

Required for write tests:

- `OPCUA_TEST_ENABLE_WRITES=true`
- `OPCUA_TEST_WRITE_NODE_ID`
- `OPCUA_TEST_WRITE_VALUE`

Only use simulator, test, or otherwise safe nodes approved by an Operator.
