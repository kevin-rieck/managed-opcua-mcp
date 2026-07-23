# PROTOTYPE — OPC UA MCP Commissioning Report

Prototype for [Prototype the commissioning report shape](https://github.com/kevin-rieck/managed-opcua-mcp/issues/5).

This is a throwaway shape prototype, not production documentation. It uses fictional data and intentionally favors review flow over raw discovery dumps.

---

# OPC UA MCP Commissioning Report

Generated: 2026-07-09T19:10:00Z  
Command: `opcua-mcp setup --config minimal.yaml --out opcua-mcp.draft.yaml --report commissioning.md --redact`  
Report mode: `redacted`  
Commissioning state: `draft_created`  
Commissioning recommendation: `not_ready_to_serve`

## 1. Summary

| Item | Result |
| --- | --- |
| OPC UA endpoint | `[redacted]` |
| Auth mode | `username` |
| Discovery roots requested | 2 |
| Discovery roots succeeded | 1 |
| Nodes visited | 184 / max 1000 |
| Discovery depth | 4 / max 10 |
| Suggested Read Entry Points | 3 |
| Draft Semantic Control candidates | 4 |
| Writable but not suggested | 7 |
| Blocking errors | 1 |
| Warnings | 5 |
| Generated config | `opcua-mcp.draft.yaml` |

**Draft status:** This config is not commissioned. Do not use with `opcua-mcp serve` until blocking errors are resolved, Operator decisions are completed, and online validation passes.

## 2. Blocking errors

These must be resolved before the config can be considered `ready_to_serve`.

| Code | Area | Message | Evidence |
| --- | --- | --- | --- |
| `root_browse_failed` | Discovery root `ns=2;s=Line2` | Requested starting Node could not be browsed by the configured credentials. | OPC UA status: `BadUserAccessDenied` |

## 3. Warnings

Warnings may be acceptable, but require Operator review.

| Code | Area | Message |
| --- | --- | --- |
| `partial_discovery` | Discovery | 1 of 2 requested roots failed. Draft config only reflects successful roots. |
| `missing_engineering_units` | `ns=2;s=Line1.Motor.SpeedSetpoint` | Numeric writable Variable has no `EngineeringUnits` Property. Operator must supply `unit`. |
| `range_not_process_bound` | `ns=2;s=Line1.Motor.SpeedSetpoint` | `EURange` was found, but must be confirmed before use as process min/max. |
| `writable_not_suggested` | Discovery | 7 writable Variables were not suggested as controls. See section 7. |
| `methods_out_of_scope` | Discovery | 2 callable Methods were found and reported only; method calls are out of scope. |

## 4. Required Operator decisions

Complete these before promoting draft candidates into executable `controls.items`.

| Code | Decision | Applies to |
| --- | --- | --- |
| `select_read_entry_points` | Choose final Read Entry Points and labels. | Suggested Read Entry Points |
| `resolve_failed_root` | Decide whether to remove failed root `ns=2;s=Line2` or fix OPC UA Server authorization. | Discovery root `ns=2;s=Line2` |
| `confirm_control_identity` | Choose final Semantic Control name and confirm description. | Each draft Semantic Control candidate |
| `assign_control_risk` | Assign Risk Level and Risk Note. | Each draft Semantic Control candidate |
| `confirm_numeric_bounds` | Confirm process min/max and unit for numeric controls. | Numeric draft candidates |
| `confirm_discrete_labels` | Confirm boolean labels or enum allowed values where applicable. | Boolean/enum-like draft candidates |
| `promote_or_reject_control` | Decide whether to promote into executable `controls.items`. | Each draft Semantic Control candidate |
| `accept_or_resolve_warnings` | Decide whether warnings are acceptable under the Operator's commissioning process. | Report warnings |

## 5. Suggested Read Entry Points

These are navigation aids only. They are not authorization boundaries.

| Suggested label | NodeId | Display name | Reason | Status |
| --- | --- | --- | --- | --- |
| `line_1` | `ns=2;s=Line1` | Line 1 | Explicit discovery root; browsed successfully. | suggested |
| `line_1_motor` | `ns=2;s=Line1.Motor` | Motor | High-level Object with readable Variables below it. | suggested |
| `line_1_status` | `ns=2;s=Line1.Status` | Status | Readable status branch with useful operational context. | suggested |

## 6. Draft Semantic Control candidates

These are **not executable**. They are candidates for Operator review.

### Candidate: `set_line_1_motor_speed`

| Field | Draft value | Source | Operator action |
| --- | --- | --- | --- |
| NodeId | `ns=2;s=Line1.Motor.SpeedSetpoint` | Discovery | Confirm |
| Data type | `Double` | `DataType` attribute | Confirm supported |
| Writable | `true` | `UserAccessLevel.CurrentWrite` | Confirm via `doctor`; still advisory |
| Description | `Motor speed setpoint` | OPC UA `Description` | Confirm/edit |
| Unit | `rpm` | `EngineeringUnits` Property | Confirm |
| Min | `0` | `EURange.low` | Confirm as process bound |
| Max | `1800` | `EURange.high` | Confirm as process bound |
| Risk Level | _missing_ | Operator-only | Required |
| Risk Note | _missing_ | Operator-only | Required |
| Cooldown | default | Config default | Optional override |

Suggested YAML fragment:

```yaml
# Draft only — review before moving into controls.items
- name: set_line_1_motor_speed
  description: Motor speed setpoint
  nodeId: ns=2;s=Line1.Motor.SpeedSetpoint
  dataType: Double
  unit: rpm # confirm
  min: 0 # confirm process bound
  max: 1800 # confirm process bound
  riskLevel: TODO
  riskNote: TODO
```

### Candidate: `set_line_1_pump_enabled`

| Field | Draft value | Source | Operator action |
| --- | --- | --- | --- |
| NodeId | `ns=2;s=Line1.Pump.Enabled` | Discovery | Confirm |
| Data type | `Boolean` | `DataType` attribute | Confirm supported |
| Writable | `true` | `UserAccessLevel.CurrentWrite` | Confirm via `doctor`; still advisory |
| Description | `Pump enable command` | OPC UA `Description` | Confirm/edit |
| False label | _missing_ | Operator-only | Required |
| True label | _missing_ | Operator-only | Required |
| Risk Level | _missing_ | Operator-only | Required |
| Risk Note | _missing_ | Operator-only | Required |

## 7. Writable but not suggested

These Nodes appeared writable but were not suggested as draft Semantic Controls.

| NodeId | Display name | Data type | Reason |
| --- | --- | --- | --- |
| `ns=2;s=Line1.Recipe.Name` | Recipe Name | `String` | Arbitrary string allowed values cannot be inferred. |
| `ns=2;s=Line1.Batch.Parameters` | Batch Parameters | `ExtensionObject` | Complex value out of scope for v1 controls. |
| `ns=2;s=Line1.ArraySetpoints` | Array Setpoints | `Double[]` | Array value rank is out of scope for v1 controls. |

## 8. Discovery coverage and evidence

| Root | Status | Nodes visited | Depth reached | Notes |
| --- | --- | --- | --- | --- |
| `ns=2;s=Line1` | succeeded | 184 | 4 | 3 continuation points consumed. |
| `ns=2;s=Line2` | failed | 0 | 0 | `BadUserAccessDenied` while browsing root. |

Metadata read summary:

| Metadata | Succeeded | Failed | Not present |
| --- | ---: | ---: | ---: |
| `Description` | 92 | 0 | 92 |
| `DataType` | 48 | 0 | 0 |
| `UserAccessLevel` | 48 | 1 | 0 |
| `EngineeringUnits` | 3 | 0 | 45 |
| `EURange` | 2 | 0 | 46 |
| `EnumValues` | 1 | 0 | 47 |

## 9. Redaction and sensitive-data note

This report was generated in redacted mode.

- No passwords, tokens, certificate private-key material, or literal secrets are saved.
- Environment variable names may appear in generated config, but secret values do not.
- Endpoint URL is redacted in this report because endpoint URLs can reveal plant/network topology.
- Current OPC UA values were not read during discovery.

## 10. Next commands

```bash
# Edit draft config and complete Operator-only fields
$EDITOR opcua-mcp.draft.yaml

# Offline validation
opcua-mcp validate --config opcua-mcp.draft.yaml

# Online commissioning diagnostics
opcua-mcp doctor --config opcua-mcp.draft.yaml --report commissioning.after-doctor.md --redact

# Serve only after blocking errors are gone and Operator accepts warnings
opcua-mcp serve --config opcua-mcp.draft.yaml
```
