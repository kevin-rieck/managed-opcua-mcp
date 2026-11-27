# Migration plan: OPC UA-native operations without a Control Catalog

Status: **Proposed implementation plan; direction agreed, details for review.**

Baseline: `5165999614089badb8ecf8bb56458f6ef7cf6d75`, branch `docs/34-opcua-native-inspection-spec`.

This plan combines three read-only Luna scouting reports with direct inspection of the implementation. No application changes, test execution, or OPC UA endpoint access were performed during planning. This document does not itself supersede the current ADRs or normative inspection specification.

## 1. Goal and ownership

Remove the mandatory Semantic Control layer. An Agent should be able to request an OPC UA write without an Operator first creating a second representation of the Node in YAML.

```text
Agent -> MCP projection -> authenticated OPC UA session -> OPC UA Server
                                                           owns authorization
```

| Concern                                                                           | Owner after migration                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| User authentication and permission to browse, read, or write                      | OPC UA Server, using the configured session identity    |
| Process safety, interlocks, and operationally safe values                         | Industrial control system and site operating procedures |
| Protocol translation, supported value encoding, request bounds, failure reporting | MCP adapter                                             |
| Write-attempt records and fail-closed pre-write audit handling                    | MCP adapter                                             |
| Genuine human approval, where required                                            | An actual approval workflow outside this adapter        |

OPC UA permission is not a process-safety guarantee. Server-provided access indicators and engineering ranges are evidence, not authorization grants or proof that a value is safe. Server-provided text remains untrusted data, never tool instructions.

## 2. Recommended scope

### Remove

- The `controls` configuration block and exported `ControlItem` type.
- `list_controls`, `write_control`, `prepare_control`, and `commit_control`.
- Named control lookup, boolean/enum label conversion, configured units/ranges, Risk Levels, Risk Notes, per-control cooldowns, and confirmation-token state.
- Catalog-specific online validation, availability summaries, and audit fields.
- Commissioning entirely: `setup`, `discover-controls`, all commissioning discovery/draft/report code, public exports, dedicated tests, and active workflow documentation. Do not retain or rename a read-only commissioning/report command.
- The requirement to read a Node before or after being allowed to write it.

Do not keep an optional catalog mode or emulate the old tools on top of native writes. That would preserve two product models and their maintenance cost.

### Keep

- Local stdio transport, one configured endpoint, and one configured OPC UA identity per MCP Server process.
- Existing browse/read tools and Read Entry Points, without semantic value conversion. Entry points remain navigation aids, never a permission list.
- Connection/authentication settings, environment-based secret references, redaction, config hashing, and explicit certificate trust validation.
- `validate`, `doctor`, `serve`, generic connection/root diagnostics, and status/config resources.
- Append-only write auditing, pre-write audit failure protection, exact operation results, no application-level mutation retries, and no mutation queue/replay after reconnect.
- Existing defensive limits and input validation. Encoding validation replaces catalog-based value validation; it does not disappear with the catalog.

### Add

One native tool:

```text
write_node(nodeId, dataType, value, reason?)
```

It writes the OPC UA Value attribute only. It is registered independently of configured roots or a catalog. The OPC UA Server decides whether the session may perform the request.

The first migration supports the same scalar datatype set already used by the write adapter: `Boolean`, `SByte`, `Byte`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Float`, `Double`, and `String`. An enum uses its actual supported numeric/string representation, not an invented label mapping.

### Not part of this migration

- Method calls, subscriptions, history, arbitrary attribute writes, arrays, matrices, custom structures, or additional scalar encodings such as Int64/UInt64.
- HTTP hosting, multi-user identity delegation, per-request credential switching, or an MCP role engine.
- A second connection/session with more powerful write credentials.
- Implementation of the entire [native inspection specification](./specs/opcua-native-inspection.md), including cursors, model context, and richer inspection profiles.
- A new approval system, policy plugin system, persistent write queue, or transactional audit platform.

Keep the inspection work separately scoped. Do not expose a small, incompatible metadata wrapper under the already-specified `inspect_node` name and claim specification conformance.

## 3. Findings that affect the design

| Evidence                                                                                                                                                                                | Consequence                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/server.ts:98-162` registers all mutation tools through catalog presence.                                                                                                       | Native write registration must not depend on `controls.items`.                                                                                                                                  |
| `src/opcua/node-opcua-gateway.ts:237-248` returns a write StatusCode as a string without classifying success.                                                                           | A returned Bad status must not be treated as success merely because the SDK did not throw.                                                                                                      |
| `src/opcua/node-opcua-gateway.ts:203-234` ignores browse result status and maps read DataValues without rejecting Bad quality; `src/mcp/server.ts` then builds successful read results. | Correct denied/failed read and browse reporting alongside write status handling. Preserve Uncertain read quality distinctly rather than flattening it into clean success or losing usable data. |
| `src/mcp/server.ts:873-902` equates write verification with subsequent readback equality.                                                                                               | A later matching value does not prove that a rejected write succeeded. A denied readback does not mean an accepted write was rejected.                                                          |
| `src/mcp/server.ts:714-848` requires an auditable, connected, online-valid, normalized control and always performs readback.                                                            | Preserve the write lifecycle protections, not the catalog gate or mandatory readability.                                                                                                        |
| `src/audit/control-audit.ts:13-47` checks health and appends records; appends can throw.                                                                                                | Audit health is not a substitute for successfully appending intent before dispatch. Completion logging can fail after a mutation.                                                               |
| `src/opcua/node-opcua-gateway.ts:322-340,488-523` creates one configured anonymous or username/password session.                                                                        | This is reuse of OPC UA identity, not propagation of an independently authenticated MCP caller.                                                                                                 |
| `src/cli/commands/setup.ts` and `src/commissioning/` mix generic metadata discovery with catalog drafts.                                                                                | Retire the entire commissioning workflow, including generic discovery/reporting code. Keep runtime browse/read and separately scoped inspection work; do not build a replacement CLI.           |

The client factory passes security mode/policy to node-opcua but does not establish the effective certificate trust behavior in repository code alone. Verify the installed SDK defaults and deployment behavior before asserting a secure trust posture. Never fix connectivity by auto-accepting untrusted certificates or downgrading security.

## 4. Native write contract

### Input and dispatch

- Accept a bounded, syntactically valid local NodeId, an explicit supported datatype, and an exact matching scalar value. Define concrete input/string bounds before implementation; do not accept arbitrary `unknown` values for forwarding.
- Reject coercion (`"true"` is not Boolean), fractional integers, out-of-range integers, non-finite or unencodable floating-point values, arrays, objects, and unsupported datatypes before dispatch.
- Validate wire representability, not site policy. Do not turn EURange, InstrumentRange, display labels, or configured roots into a replacement permission/safety layer.
- Do not require a successful metadata read or `writable: true` before sending Write. That would break write-only users and turn advisory metadata into another authorization gate.
- Once dispatched, invoke the gateway mutation once. No application retry, no deferred queue, and no replay after reconnect. Verify SDK reconnect behavior does not replay a completed or ambiguous mutation.
- Mark the tool as mutating and not generally idempotent in MCP annotations. Writing the same value twice can still have side effects.

### Results

Use exact OPC UA StatusCodes, with numeric value authoritative. Reuse the existing inspection specification's `{ value, hex, name }` representation rather than inventing a second incompatible status format. Preserve service-level failures as well as per-operation statuses.

Distinguish these outcomes in responses and audit records:

| Situation                                                                      | Required interpretation                                                                                        |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Invalid request, disconnected preflight, or intent append failed               | Not attempted; no Write invocation                                                                             |
| Good Write StatusCode                                                          | Server accepted the request; not proof of completed physical action                                            |
| Bad Write StatusCode, including `BadUserAccessDenied` or `BadNotWritable`      | Rejected/failed operation with exact status; never success                                                     |
| Uncertain or absent/malformed Write status                                     | Unconfirmed/unknown outcome; never unconditional success                                                       |
| Timeout/disconnect/exception after invoking Write, without a definitive result | Outcome unknown; it may have changed state; do not retry automatically                                         |
| Completion audit append failed after a definitive OPC UA result                | Preserve that known write outcome and separately report audit failure; do not falsely say no mutation occurred |

Finalize exact JSON shapes and stable error codes before coding, including how `ok` relates to write outcome and audit health. Prefer the existing structured tool-result style; mutation and audit outcome must remain independently visible.

Recommendation: **no automatic readback**. An Agent can explicitly call `read_node` when its identity permits. The migration notes must explain that server acceptance replaces the former automatic Write Verification result. Readback is a separate observation, not an atomic transaction or process-safety check.

### Audit

Keep audit mandatory for native writes; removing the catalog is not a reason to remove audit.

- Give each write attempt a correlation ID returned to the Agent; individual before/after records retain unique record IDs.
- Record NodeId, datatype, requested scalar value, config hash, timestamp, outcome, and exact OPC UA status when known. Bound any reason text.
- Use native write events instead of control names, Risk Levels, confirmation events, or normalized/raw value pairs.
- Require the intent append to succeed before Write, even if the health probe succeeded. A failing intent append prevents dispatch.
- Record returned rejection, accepted result, or ambiguous transport outcome after dispatch. If completion append fails, return an explicit audit error with the known/unknown write outcome and correlation ID; never reissue Write to repair logging.
- Define coverage for schema-valid requests rejected before dispatch. Schema-invalid MCP requests need not masquerade as dispatched write attempts.
- Do not invent caller identity or log credentials. The configured session principal is not evidence of an independent human or Agent identity.
- Keep operational logs free of values/secrets by default; protect the audit file separately because it deliberately contains targets and requested values.

An awaited JSONL append is the existing persistence level, not an atomic transaction with OPC UA or a promise of fsync/crash durability. Do not add a new journal/database solely for this migration.

## 5. Configuration and operator migration

Recommend a strict **`version: 2`** schema containing `connection`, optional `read`, and mandatory `audit`. Remove the entire `controls` shape; keep strict unknown-field rejection.

Reject every v1 config, including configs with no controls or disabled controls, before creating a gateway. Give an actionable migration error. Do not silently strip controls, reinterpret omission as native write approval, auto-upgrade YAML, or edit local/site files.

Manual cutover:

1. Retain the previous executable/package and original v1 config for rollback. Stop the old MCP process before starting the replacement.
2. Review the OPC UA account's actual permissions, including anonymously accessible writes. Use a dedicated least-privilege identity, not administrator credentials.
3. For read-only operation, verify that the OPC UA Server denies writes for that identity. Omitting `controls` no longer removes write tools.
4. Create a separate v2 config: copy connection, read navigation/limits, and audit settings; remove controls and change version only after reviewing the new capability model.
5. Run local `validate`, then `doctor` for connectivity/root diagnostics. Neither command performs a write or certifies all Node permissions/process safety.
6. Exercise read/write denial and allowed writes on an isolated simulator, not production equipment. Update Agent prompts/scripts to use `write_node` and raw values.
7. Start stdio `serve`, check status and audit behavior, and roll back on unexpected permissions or outcome reporting.

Update both examples. `examples/read-only.config.yaml` must say that read-only behavior comes from server-enforced account permissions; an example file alone cannot guarantee it. Do not retain anonymous credentials as an implied read-only guarantee. Local insecure examples must be clearly simulator-only.

Version 2 is the configuration version, not necessarily npm major version 2. Record the breaking tool/config/audit change at the chosen package release boundary.

## 6. Change map

| Area                                            | Required work                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/schema.ts`, `load-config.ts`        | Strict v2, actionable v1 rejection, remove catalog schema/type; retain secret handling/hash and read limits.                                                                                                                                    |
| `src/mcp/server.ts`                             | Replace four catalog tools with `write_node`; delete confirmation/cooldown/catalog helpers; return native read values and accurate operation statuses. Keep existing read navigation contracts unless separately revised.                       |
| `src/opcua/gateway.ts`, `node-opcua-gateway.ts` | Preserve typed write plumbing; expose exact statuses, classify returned failures, retain single-session ownership; verify no mutation replay.                                                                                                   |
| `src/control/value-normalization.ts`            | Remove catalog normalization; implement only the small supported-scalar encoder/validator needed by native writes, with datatype boundary tests.                                                                                                |
| `src/audit/`                                    | Retain sink/seam; replace control-specific record fields/events/helper naming with native write-attempt records and robust before/after failure reporting.                                                                                      |
| `src/mcp/online-validation.ts`                  | Remove catalog-target checks/cache fields; retain root/connectivity diagnostics without gating native write authorization.                                                                                                                      |
| `src/mcp/resources.ts`                          | Remove catalog counts/defaults/availability; retain connection, diagnostics, audit health, redacted config, and hash.                                                                                                                           |
| `src/cli/index.ts`, `commands/doctor.ts`        | Remove `setup`, `discover-controls`, their options/helpers/imports, and disabled-control diagnostics/options; retain validate/doctor/serve and unrelated deprecated `validate-config` alias.                                                    |
| `commands/setup.ts`, `src/commissioning/`       | Delete `src/cli/commands/setup.ts` and all of `src/commissioning/`, including discovery, drafts, reports, and coverage models. Remove `discoverCommissioning` and its interface/imports from the gateway; do not retain a replacement workflow. |
| `src/index.ts`, `src/types/result.ts`           | Remove obsolete control and commissioning exports/reason vocabulary and verify every remaining caller. Preserve runtime read-entry-point and OPC UA operation interfaces.                                                                       |
| `tests/`                                        | Replace obsolete control contracts with native operation behavior; delete `tests/commissioning/` and commissioning-only CLI cases; retain and adapt audit, auth, connection, browse/read, and root-diagnostic tests.                            |
| `examples/`, package/CLI descriptions           | Match v2 capabilities, server-enforced read-only behavior, and new workflow.                                                                                                                                                                    |

Do not remove `opcua://read-scope`, identifier-less browsing, or other unrelated compatibility behavior simply because the separate inspection specification plans to do so. Handle those in its own implementation or explicitly combine the release contracts first.

## 7. Documentation precedence

This migration conflicts with both existing ADRs and the normative next-release inspection spec. Address those conflicts explicitly, not by quietly changing code beneath them.

Implementation must:

- Add ADR 0003 for native operations/server-owned authorization and its capability-expansion trade-off; mark ADR 0001 superseded and ADR 0002's retained-catalog decision superseded. Preserve the historical reasoning.
- Update `CONTEXT.md` to describe actual retained concepts, without turning the glossary into a migration spec.
- Reconcile `README.md`, `SECURITY.md`, `docs/prd.md`, `docs/plan.md`, and `docs/operator-guide.md` with the new tool/config/safety model. `SECURITY.md` already mentions an unsupported `server.mode`; do not carry that advice forward.
- Amend the inspection spec's precedence/config-compatibility clauses, workflow/operator-impact sections, raw-write non-goals, control separation, section 15, test matrix, and release acceptance (not just section 15). It currently requires v1 configs to keep parsing and the Control Surface to remain unchanged.
- Preserve the inspection spec's source-trust, native metadata, read-only capability separation, and read-only no-Control-Attempt-audit intent. New mutation code must not leak into the inspection interface.
- Remove commissioning setup/report instructions and links from active documentation; explain that `setup` and `discover-controls` are retired without replacement commands.
- Mark historical research/prototype documents, including commissioning report prototypes, as historical where necessary rather than rewriting past findings as if native writes were always intended.

## 8. Dependency-ordered implementation slices

The slices are reviewable commits or PRs, not independently deployable mixed-contract releases. Ship the v2 cutover only after the complete acceptance gate passes.

### A. Freeze the v2 contract

Resolve the decisions in section 10; specify write inputs/results/audit events and concrete bounds. Record ADR precedence and migration documentation. Pin expected tool/resource/schema behavior in tests.

**Exit:** one product model, explicit breaking changes, no ambiguity about identity, read-only operation, or write success.

### B. Correct shared OPC UA result handling

Implement exact status mapping/classification and typed scalar validation. Test returned Bad statuses, service failures, Uncertain quality, and representation boundaries. Verify SDK mutation replay behavior and certificate trust assumptions.

**Exit:** native protocol results cannot be mistaken for successful authorization merely because no exception was thrown.

### C. Implement audited native writes

Add `write_node`, single-dispatch lifecycle, correlation, before/after audit handling, and independent mutation/audit outcomes. Remove mandatory metadata/readback prerequisites. Prove write-only access works.

**Exit:** successful, rejected, and ambiguous mutations are distinguishable and never automatically retried.

### D. Remove catalog and migrate config/CLI

Remove old tools/state/normalization/config/exports, catalog diagnostics, and the entire commissioning workflow, including its gateway methods and dedicated tests. Introduce strict v2 startup rejection of v1. Remove both commissioning commands without aliases/replacements and migrate resources/examples.

**Exit:** no operational catalog path remains, no legacy config is silently reinterpreted, and retained commands have a purpose.

### E. Complete acceptance and operator cutover

Finish docs/spec reconciliation, real protocol-backed simulator tests, MCP/CLI compatibility tests, and optional external-smoke documentation. Run the full local checks before recommending migration.

**Exit:** the acceptance matrix below passes, migration instructions are exercised against test configs, and rollback artifacts remain usable.

## 9. Acceptance matrix

| Behavior                    | Required proof                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No mandatory catalog        | `write_node` works with no control configuration; the four old tools are absent; resources have no catalog policy.                                                                                                                              |
| Strict migration            | v1 with controls enabled, disabled, empty, or absent all fail before gateway creation; v2 rejects removed fields; no source file is rewritten.                                                                                                  |
| Native scalar encoding      | Every supported type and edge boundary; integer fractions/range overflow, unsafe precision, non-finite/unencodable floats, coercion, oversized strings/NodeIds, arrays/objects, unsupported types rejected before Write.                        |
| Server authority            | Returned `BadUserAccessDenied` and `BadNotWritable` survive SDK -> gateway -> MCP -> audit; access metadata does not grant permission or block an otherwise permitted write.                                                                    |
| Allowed/denied identities   | Deterministic in-process OPC UA Server with restricted principals; read-only principal cannot write; write-only principal can write without readback. Use separate MCP instances sequentially, not new production identity-switching machinery. |
| Read/browse accuracy        | Returned denied/Bad results do not become `ok: true`; Uncertain read quality and exact status remain visible; existing per-node batch isolation survives.                                                                                       |
| Audit fail-closed           | Unhealthy sink and actual intent-append failure both produce zero mutations. Test the health-success/append-failure case.                                                                                                                       |
| Post-dispatch audit failure | Exactly one mutation; response preserves known accepted/rejected or unknown outcome plus explicit audit failure and correlation ID.                                                                                                             |
| Lost response/reconnect     | Timeout/disconnect after dispatch yields unknown outcome; no application retry or later replay/queue. Verify relevant SDK behavior, not only a mock call count.                                                                                 |
| No forced readability       | No metadata/value Read is required by `write_node`; a later failed read is not reported as a rejected earlier write.                                                                                                                            |
| Secrets and trust           | Environment secret references remain required/redacted; no invented caller identity; no trust bypass or security downgrade. Invalid policy configuration fails clearly.                                                                         |
| Retained interfaces         | Exact tool/resource schemas, raw boolean/enum reads, root diagnostics and CLI outputs; removed commands fail clearly and retained aliases still work.                                                                                           |
| Commissioning retirement    | `setup` and `discover-controls` fail as removed commands; no commissioning source, gateway method, exports, dedicated tests, or active setup/report instructions remain. Existing browse/read and root diagnostics still work.                  |
| External integration        | Existing endpoint tests remain opt-in; live writes retain explicit enable flag, designated safe Node and value. Never use a production endpoint in default CI.                                                                                  |

Run `npm run check`, `npm run build`, and targeted formatter checks, plus the mandatory isolated protocol-backed tests. Audit the diff for obsolete runtime imports/exports and misleading active documentation. Do not claim the separate full inspection specification has passed merely because this smaller matrix passes.

## 10. Decisions to confirm before implementation

The architectural direction is already agreed: **remove mandatory Semantic Controls and allow native NodeId writes subject to OPC UA Server authorization.** Commissioning is also explicitly retired in its entirety, including standalone read-only discovery/reporting, without a replacement CLI workflow. Do not reopen either decision as an unresolved scouting question.

| Decision                              | Recommendation                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean break or optional legacy layer? | Clean v2 break; remove old tools/config, no dual mode.                                                                                                                          |
| First write scope?                    | Value-attribute writes for the existing ten scalar types; explicit datatype/value; methods and richer encodings later.                                                          |
| Readback behavior?                    | No automatic readback; explicit reads are independent observations.                                                                                                             |
| Audit?                                | Mandatory write audit, intent append before dispatch, independent post-write audit-error reporting.                                                                             |
| Identity/read-only deployments?       | One existing configured OPC UA identity per process; server-enforced read-only roles. No shared admin account or automatic per-caller identity claim.                           |
| Commissioning reports?                | Confirmed: retire commissioning entirely, including generic discovery/reporting, both commands, source, exports, dedicated tests, and active workflow docs. No replacement CLI. |
| Relationship to inspection release?   | Reconcile conflicting clauses now; implement the large inspection slice separately, without unrelated read-interface changes here.                                              |

Commissioning retirement is settled. Exact write response/error shapes, input bounds, and verified SDK trust/replay behavior remain contract/engineering prerequisites, not reasons to rebuild a semantic policy layer or a commissioning workflow.
