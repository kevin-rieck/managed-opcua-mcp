# Optional OPC UA integration tests

Real OPC UA integration tests are opt-in. Normal `npm test` runs and CI do not require an OPC UA Server because these tests skip unless the required environment variables are present.

## Connect/status tests

Required:

- `OPCUA_TEST_ENDPOINT`

Optional auth/security settings:

- `OPCUA_TEST_SECURITY_MODE` (default: `None`)
- `OPCUA_TEST_SECURITY_POLICY` (default: `None`)
- `OPCUA_TEST_USERNAME`
- `OPCUA_TEST_PASSWORD`

Set both username and password when the endpoint requires username/password auth.

## Read tests

Required:

- `OPCUA_TEST_ENDPOINT`
- `OPCUA_TEST_READ_NODE_ID`

## Write tests

Writes are extra opt-in and are skipped unless all of these are set:

- `OPCUA_TEST_ENDPOINT`
- `OPCUA_TEST_ENABLE_WRITES=true`
- `OPCUA_TEST_WRITE_NODE_ID`
- `OPCUA_TEST_WRITE_VALUE`

Optional:

- `OPCUA_TEST_WRITE_DATA_TYPE` (default: `String`)

**Safety warning:** only use simulator, test, or otherwise safe write Nodes approved by an Operator. Never point write integration tests at production controls or unsafe plant equipment.
