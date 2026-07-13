import { describe, expect, it } from 'vitest';
import { generateCommissioningMarkdownReport } from '../../src/commissioning/markdown-report.js';
import type { CommissioningDiscoveryResult, Evidence } from '../../src/commissioning/discovery.js';

describe('commissioning Markdown report', () => {
  it('renders the Operator review flow from a commissioning discovery result', () => {
    const report = generateCommissioningMarkdownReport(discovery(), {
      endpointUrl: 'opc.tcp://plant.example:4840',
      authMode: 'usernamePassword',
      generatedConfigPath: 'opcua-mcp.draft.yaml',
    });

    expect(report).toContain('# OPC UA MCP Commissioning Report');
    expect(report).toContain('Commissioning recommendation: `not_ready_to_serve`');
    expect(report).toContain('| OPC UA endpoint | `[redacted]` |');
    expect(report).toContain('## 2. Blocking errors');
    expect(report).toContain('`root_browse_failed`');
    expect(report).toContain('## 4. Required Operator decisions');
    expect(report).toContain('`assign_control_risk`');
    expect(report).toContain('## 5. Suggested Read Entry Points');
    expect(report).toContain('navigation aids only. They are not authorization boundaries');
    expect(report).toContain('## 6. Draft Semantic Control candidates');
    expect(report).toContain('# Draft only — inactive and requires Operator review');
    expect(report).toContain('riskLevel: TODO');
    expect(report).toContain('## 7. Writable but not suggested');
    expect(report).toContain('## 8. Discovery coverage and evidence');
    expect(report).toContain('| `DataType` | 1 | 1 | 0 |');
    expect(report).toContain('## 9. Redaction and sensitive-data note');
  });

  it('is deterministic across unordered result collections', () => {
    const first = discovery();
    first.findings.warnings.push({
      code: 'max_depth_reached',
      area: 'A root',
      message: 'Depth cap reached.',
    });
    first.suggestedReadEntryPoints.push({
      nodeId: 'ns=2;s=A',
      suggestedLabel: 'a_root',
      reason: 'readable_branch',
      evidence: [],
    });
    const reordered = structuredClone(first);
    reordered.findings.warnings.reverse();
    reordered.suggestedReadEntryPoints.reverse();
    reordered.roots.reverse();
    reordered.draftSemanticControls.reverse();
    reordered.writableButNotSuggested.reverse();

    expect(generateCommissioningMarkdownReport(first)).toBe(
      generateCommissioningMarkdownReport(reordered),
    );
  });

  it('redacts secret references and embedded endpoint credentials while allowing topology visibility', () => {
    const input = discovery();
    input.findings.warnings.push({
      code: 'metadata_read_failed',
      area: '${PLANT_USERNAME}',
      message: 'Credential ${PLANT_PASSWORD} was rejected.',
    });
    const candidate = input.draftSemanticControls[0];
    if (candidate === undefined) throw new Error('fixture must include a draft candidate');
    candidate.description = 'Set ${CONTROL_SECRET}\n```';

    const report = generateCommissioningMarkdownReport(input, {
      endpointUrl: 'opc.tcp://operator:literal-secret@plant.example:4840',
      authMode: 'usernamePassword',
      redactEndpoint: false,
    });

    expect(report).toContain('opc.tcp://plant.example:4840');
    expect(report).toContain('[redacted-secret-ref]');
    expect(report).not.toContain('operator');
    expect(report).not.toContain('literal-secret');
    expect(report).not.toContain('PLANT_PASSWORD');
    expect(report).not.toContain('CONTROL_SECRET');
    expect(report).toContain('current OPC UA values are not included');
  });

  it('requires Operator review even when discovery has no blocking errors', () => {
    const input = discovery();
    input.findings.blocking = [];

    const report = generateCommissioningMarkdownReport(input);

    expect(report).toContain('Commissioning recommendation: `operator_review_required`');
    expect(report).toContain('| _None_ | — | — | — |');
  });
});

function discovery(): CommissioningDiscoveryResult {
  return {
    generatedAt: '2026-07-13T20:00:00.000Z',
    roots: [
      {
        nodeId: 'ns=2;s=Line1',
        status: 'partial',
        nodesVisited: 2,
        depthReached: 1,
        statusDetail: { severity: 'bad', code: 'BadUserAccessDenied' },
      },
    ],
    nodes: [],
    suggestedReadEntryPoints: [
      {
        nodeId: 'ns=2;s=Line1',
        suggestedLabel: 'line_1',
        displayName: 'Line 1',
        reason: 'requested_root',
        evidence: [evidence('browsed')],
      },
    ],
    draftSemanticControls: [
      {
        nodeId: 'ns=2;s=Line1.Speed',
        suggestedName: 'set_line_1_speed',
        suggestedGroup: 'line_1',
        description: 'Line speed',
        dataType: 'Double',
        unit: 'rpm',
        normalRange: { low: 0, high: 1800 },
        draftState: 'inactive_review_required',
        eligibility: 'needs_operator_review',
        reasons: ['scalar_supported_data_type', 'operator_safety_fields_required'],
        evidence: [evidence('Double')],
      },
    ],
    writableButNotSuggested: [
      {
        nodeId: 'ns=2;s=Line1.Parameters',
        displayName: 'Parameters',
        dataType: 'ExtensionObject',
        reasons: ['unsupported_data_type'],
        evidence: [evidence('ExtensionObject')],
      },
    ],
    findings: {
      blocking: [
        {
          code: 'root_browse_failed',
          area: 'ns=2;s=Line2',
          message: 'Requested root could not be browsed.',
          evidence: [evidence('BadUserAccessDenied')],
        },
      ],
      warnings: [
        {
          code: 'partial_discovery',
          area: 'Discovery',
          message: 'Only part of the requested address space was inspected.',
        },
      ],
    },
    coverage: {
      requestedRoots: 2,
      succeededRoots: 1,
      failedRoots: 1,
      nodesVisited: 2,
      maxNodes: 100,
      depthRequested: 4,
      depthReached: 1,
      fields: { DataType: { succeeded: 1, failed: 1, notPresent: 0 } },
    },
  };
}

function evidence<T>(value: T): Evidence<T> {
  return {
    value,
    source: 'metadata_read',
    status: { severity: 'good', code: 'Good' },
  };
}
