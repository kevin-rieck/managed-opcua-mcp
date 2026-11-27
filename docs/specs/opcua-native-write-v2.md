# Native write and configuration v2 contract

Status: **Accepted contract implemented in the current checkout; release acceptance remains pending.** This document freezes slice A of the [migration plan](../opcua-native-migration-plan.md). Ship no mixed v1/v2 release. ADR 0003 decides the authorization model. The full [inspection specification](opcua-native-inspection.md) is a separate implementation slice, not a prerequisite claim of this contract.

## Tool input

Register `write_node` for every v2 configuration, including empty `read.roots`. Its annotations are `readOnlyHint: false`, `idempotentHint: false`, `openWorldHint: true`. It writes only AttributeId 13 (Value). Use the existing configured OPC UA session; never infer an individual caller or switch credentials. Inputs are a closed JSON object with required `nodeId`, `dataType`, `value`, and optional `reason`. The registered structural schema accepts `nodeId`, `dataType`, and `reason` as strings and `value` as any JSON value; semantic validation below returns a structured result, not an MCP schema error. Missing fields, wrong string types, or extra properties are MCP schema errors and are outside audit coverage. No coercion or defaults apply to input fields.

- `nodeId`: 1–4,096 Unicode scalar values, valid UTF-16 with no unpaired surrogates, and an OPC UA Part 6 local NodeId in `i=`, `s=`, `g=`, or `b=` form with optional `ns=<decimal>;` prefix. Namespace is 0–65535; numeric identifier is 0–4294967295; GUID is canonical hyphenated; ByteString is padded standard base64. String identifier may contain semicolons after `s=`. Reject ExpandedNodeId `nsu=`/`svr=` forms and malformed/overflow forms; no label lookup. Parse the complete input without trimming or silently repairing it. Store the canonical local text described by inspection spec section 6.7 and dispatch the parsed NodeId without lossy SDK string reparsing. In particular, the installed SDK string parser is permissive and its namespace/string regex does not preserve line terminators; validate the entire input independently and construct the NodeId from parsed components.
- `dataType`: exactly one of `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, `String`. Unsupported values are semantic failures.
- `value`: exactly the corresponding JSON boolean, number, or string. Integers must be integral and within SByte −128..127, Byte 0..255, Int16 −32768..32767, UInt16 0..65535, Int32 −2147483648..2147483647, or UInt32 0..4294967295. All are exactly representable in JavaScript. Float and Double require finite JSON numbers; Float must remain finite after IEEE 754 binary32 conversion (rounding to binary32, including underflow to zero, is permitted); Double uses the parsed binary64 value. String is 0–4,096 Unicode scalar values, valid UTF-16; do not normalize, clip, or strip controls. Reject null, arrays, objects, wrong types, and out-of-range values. No labels, unit conversion, metadata lookup, or site-policy ranges.
- `reason`: if supplied, 1 through the configured `audit.maxReasonLength` Unicode scalar values, valid UTF-16; reject overlong/invalid text rather than truncate it. The config bound remains 1–10,000, default 1,000. No reason is required.

JSON numbers are interpreted as the parsed IEEE 754 binary64 value. A client needing exact decimal semantics must not assume decimal text survives parsing or Float conversion. `-0` may serialize as `0`. No automatic readback is performed: a later explicit read is an independent observation, not an atomic transaction or safety check.

## Response and status

Every handler-produced result is one MCP text content containing a JSON body, with `isError: false`; expected failures use the body. Protocol/schema failure is the exception described above. All object shapes below are closed; optional properties are absent, not null. UUIDs are lowercase canonical UUIDv4. The `attemptId` is generated once for every structurally valid request before semantic validation. Audit record IDs are distinct UUIDv4 values, including from the attempt ID.

```ts
type StatusCode = { value: number; hex: string; name: string };
type WriteErrorCode =
  | 'invalid_node_id'
  | 'node_id_too_long'
  | 'unsupported_data_type'
  | 'invalid_value'
  | 'value_out_of_range'
  | 'value_too_long'
  | 'invalid_reason'
  | 'disconnected'
  | 'audit_unavailable'
  | 'opcua_write_rejected'
  | 'opcua_service_error'
  | 'write_outcome_unknown';
type WriteError = { code: WriteErrorCode; message: string; statusCode?: StatusCode };
type Mutation =
  | { outcome: 'not_attempted'; error: WriteError }
  | { outcome: 'accepted'; statusCode: StatusCode }
  | { outcome: 'rejected'; statusCode: StatusCode; error: WriteError }
  | { outcome: 'unknown'; error: WriteError };
type Audit =
  | { outcome: 'recorded'; recordIds: string[] }
  | { outcome: 'failed'; recordIds: string[]; error: WriteError };
type WriteResult = { ok: boolean; attemptId: string; mutation: Mutation; audit: Audit };
```

`StatusCode` uses inspection section 6.3: `value` is the authoritative unsigned 32-bit number; `hex` is `0x` plus eight lowercase hex digits; `name` is the canonical SDK name or `Unknown`. Classify severity from the numeric top two bits: 00 Good, 01 Uncertain, 10 Bad; reserved 11 is unclassifiable. Never classify by name or hex. Preserve information bits. A per-operation Good is `accepted`, Bad is `rejected` with `opcua_write_rejected`, and Uncertain is `unknown` with `write_outcome_unknown`. A status with reserved severity bits is unknown with `write_outcome_unknown` and its numeric status retained in the error; missing/malformed operation status is unknown without status. A service-level failure without a correlated per-operation status is `unknown`, with `opcua_service_error` and its exact service StatusCode when available; an exception, timeout, connection loss, or cancellation after gateway invocation is `unknown` with `write_outcome_unknown` unless a definitive operation result is already known. Do not turn an SDK exception into a denial without a definitive correlated operation status. Error `statusCode` is required whenever known and, for a rejected mutation, equals `mutation.statusCode`; otherwise omit it. Error messages are fixed, safe single-line text, at most 1,024 Unicode scalar values; never include raw SDK text, credentials, endpoint secrets, values, or stack traces.

`ok` is true **only** when `mutation.outcome` is `accepted` and `audit.outcome` is `recorded`; it is false for every other combination. Thus a known accepted mutation and a failed completion append has `ok: false` while retaining `mutation.outcome: "accepted"`. A Good status means Server acceptance, not physical completion. A client must not automatically retry an unknown outcome or an audit failure. `audit.recordIds` contains only IDs whose appends resolved successfully, in append order; `audit.error.code` is always `audit_unavailable`. An append failure can be ambiguous: bytes may have reached the file even if the append rejected; no ID in `recordIds` asserts absence from the file.

## Lifecycle and audit

The JSONL audit is mandatory. For each structurally valid request use this order, with no OPC UA Write before step 4:

1. Allocate `attemptId`; validate NodeId, datatype, value, and reason in that order. For invalid inputs select the first corresponding error above. `invalid_value` covers wrong type, null/array/object, invalid Unicode or non-finite numbers; `value_out_of_range` covers integer and Float range; `value_too_long` covers String length; `invalid_reason` covers any reason violation.
2. On validation failure, attempt one `write.preflight` append and return `not_attempted`. Otherwise probe audit health. If unhealthy or the probe throws, attempt one `write.preflight` append with `audit_unavailable` and return `not_attempted` regardless of append result. A successful diagnostic append does not override the failed health gate.
3. Check connection without issuing a Write. On disconnected status or failed connection check, attempt one `write.preflight` append with `disconnected` and return `not_attempted`. On a healthy connected path, append `write.intent` and await success. If the intent append fails, return `not_attempted` with `audit_unavailable`, `audit.outcome: "failed"`; do not dispatch. A diagnostic append after a failed intent is not required or attempted.
4. Invoke gateway Write exactly once. There is no metadata/value pre-read, application mutation retry, queue, or replay. Classify the result above, then attempt one `write.completion` append, even on exception or ambiguous result. After dispatch, caller cancellation must not suppress the completion append attempt; response delivery may be impossible after transport cancellation. Never issue another Write to repair audit. If this append fails, retain the mutation outcome and report audit failure separately.

For preflight rejection, `audit.outcome` is `recorded` only if the preflight append resolved; otherwise it is `failed`. For dispatched requests it is `recorded` only if both intent and completion appends resolved. A record is a single JSON object followed by a newline, with these closed shapes:

```ts
type AuditBase = {
  id: string;
  attemptId: string;
  timestamp: string;
  configHash: string;
  nodeId?: string;
  dataType?: string;
  requestedValue?: boolean | number | string;
  reason?: string;
};
type AuditRecord =
  | (AuditBase & {
      event: 'write.preflight';
      mutation: Extract<Mutation, { outcome: 'not_attempted' }>;
    })
  | (AuditBase & { event: 'write.intent'; mutation: { outcome: 'pending' } })
  | (AuditBase & {
      event: 'write.completion';
      mutation: Exclude<Mutation, { outcome: 'not_attempted' }>;
    });
```

Timestamps are UTC ISO-8601; `configHash` is the existing 16-character lowercase hash of the redacted effective config. Include a field in preflight only after that field independently passes its own validation, even if an earlier field failed; requestedValue is included only when the datatype and value match and both validate; never include unbounded or invalid input. On intent/completion include canonical NodeId, supported datatype, validated requested scalar, and reason if provided. The same validated input fields are used in both records, and mutation/error/status objects match the response. Preflight diagnostic records do not claim an intent or a dispatched write. No caller identity, credentials, raw SDK errors, catalog names, risk labels, or raw/normalized pairs are recorded. The audit file deliberately contains values and targets and must be access-protected; default operational logs must not contain these or secrets. An awaited append is not fsync or a transaction with OPC UA: crashes can leave an intent without completion, or a completion whose response was lost. Absence of completion is not proof of no mutation.

## Configuration and cutover

V2 is a strict top-level object with required `version: 2`, `connection`, and `audit`, optional `read`, and no `controls` or unknown fields. For this migration, retain the existing v1 connection/auth, read, and audit field schemas, defaults, validation, secret-reference resolution/redaction, and hash behavior, except for removed control/name cross-checks. Read root labels remain unique. Do not silently enable the separately specified inspection schema/defaults; when that separate slice ships, its section 13 read rules apply to v2. No site YAML is rewritten. Detect `version: 1` before environment resolution, gateway creation, or connection and fail with a non-secret actionable error: `Configuration version 1 is unsupported; manually create a version 2 config after reviewing OPC UA account write permissions and removing controls.` Reject v1 regardless of whether controls are present, disabled, or empty. Other invalid versions and unknown fields fail strict validation.

This is a capability expansion even for a formerly read-only config. Copy connection, read, and audit settings into a separate v2 file, remove `controls`, and set version only after reviewing account permissions. Stop the old process; retain its binary and original v1 file for rollback. Use least-privilege server roles, including for anonymous sessions; absence of controls is not read-only. `validate` and `doctor` do not write or certify safety. Test denial and allowed writes only on an isolated simulator before cutover. Update Agent clients to `write_node` and raw scalar values; automatic Write Verification is removed. `setup` and `discover-controls` and commissioning are retired without replacement. See plan section 5 for the full cutover. See the [operator guide](../operator-guide.md) for current instructions.

## Implementation acceptance seams

Test exact registered schema/annotations and result/record shapes, all scalar boundaries and malformed/local NodeIds, semantic-invalid and disconnected preflight records, unhealthy health and successful-health/failed-intent paths, returned Bad/Uncertain/service statuses and numeric/name disagreement, write-only access, accepted/rejected/unknown plus completion append failure, one invocation and no replay, config v1 rejection before gateway creation, strict v2 and redaction. See [SDK evidence](../opcua-sdk-slice-b-evidence.md) for the limited verified trust and replay paths and remaining risks; this contract alone is not implementation evidence.
