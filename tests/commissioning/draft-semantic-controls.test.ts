import { describe, expect, it } from 'vitest';
import { generateDraftSemanticControlCandidates } from '../../src/commissioning/draft-semantic-controls.js';
import type {
  CommissioningDiscoveryResult,
  CommissioningNode,
  CommissioningSupportedControlDataType,
  Evidence,
} from '../../src/commissioning/discovery.js';

describe('draft Semantic Control candidate generation', () => {
  it('suggests an inactive numeric candidate from a scalar session-writable Variable', () => {
    const result = generateDraftSemanticControlCandidates(
      discovery([
        variable({
          nodeId: 'ns=2;s=Machine.SpeedSetpoint',
          browseName: '2:SpeedSetpoint',
          displayName: 'Speed Setpoint',
          path: ['Machine', 'Speed Setpoint'],
          description: evidence('Motor speed setpoint'),
          dataType: {
            opcuaName: 'Double',
            mappedType: 'Double',
            evidence: evidence('Double'),
          },
          dataAccess: {
            engineeringUnits: evidence({ displayName: 'rpm' }),
            euRange: evidence({ low: 0, high: 1800 }),
          },
        }),
      ]),
    );

    expect(result.draftSemanticControls).toEqual([
      expect.objectContaining({
        nodeId: 'ns=2;s=Machine.SpeedSetpoint',
        suggestedName: 'set_machine_speed_setpoint',
        suggestedGroup: 'machine',
        description: 'Motor speed setpoint',
        dataType: 'Double',
        unit: 'rpm',
        normalRange: { low: 0, high: 1800 },
        draftState: 'inactive_review_required',
        eligibility: 'needs_operator_review',
      }),
    ]);
    expect(result.writableButNotSuggested).toEqual([]);
  });

  it('reports writable Variables that fail candidate eligibility with stable reasons', () => {
    const result = generateDraftSemanticControlCandidates(
      discovery([
        writableNode('ns=2;s=Array', {
          displayName: 'Array',
          valueShape: { kind: 'array', evidence: evidence('array') },
          dataType: supportedType('Double'),
        }),
        writableNode('ns=2;s=UnknownShape', {
          displayName: 'Unknown Shape',
          valueShape: { kind: 'unknown', evidence: evidence('unknown') },
          dataType: supportedType('Double'),
        }),
        writableNode('ns=2;s=Structure', {
          displayName: 'Structure',
          dataType: { opcuaName: 'ExtensionObject', evidence: evidence('ExtensionObject') },
        }),
        writableNode('ns=2;s=UnknownType', { displayName: 'Unknown Type' }),
        writableNode('ns=2;s=NoIdentity', { dataType: supportedType('Boolean') }),
      ]),
    );

    expect(result.draftSemanticControls).toEqual([]);
    expect(result.writableButNotSuggested).toEqual([
      expect.objectContaining({ nodeId: 'ns=2;s=Array', reasons: ['array_value_shape'] }),
      expect.objectContaining({
        nodeId: 'ns=2;s=NoIdentity',
        reasons: ['missing_identity_context'],
      }),
      expect.objectContaining({ nodeId: 'ns=2;s=Structure', reasons: ['unsupported_data_type'] }),
      expect.objectContaining({
        nodeId: 'ns=2;s=UnknownShape',
        reasons: ['array_value_shape'],
      }),
      expect.objectContaining({ nodeId: 'ns=2;s=UnknownType', reasons: ['missing_data_type'] }),
    ]);
    expect(result.findings.warnings.map((finding) => finding.code)).toEqual(
      Array.from({ length: 5 }, () => 'writable_not_suggested'),
    );
  });

  it('generates review-required Boolean, String, and enum-like numeric hints without Operator-only fields', () => {
    const result = generateDraftSemanticControlCandidates(
      discovery([
        writableNode('ns=2;s=Mode', {
          displayName: 'Operating Mode',
          dataType: supportedType('Int32'),
          dataAccess: {
            enumStrings: evidence(['Off', 'Production Run']),
          },
        }),
        writableNode('ns=2;s=Enabled', {
          displayName: 'Enabled',
          dataType: supportedType('Boolean'),
        }),
        writableNode('ns=2;s=Recipe', {
          displayName: 'Recipe Name',
          dataType: supportedType('String'),
        }),
      ]),
    );

    expect(result.draftSemanticControls).toEqual([
      expect.objectContaining({
        nodeId: 'ns=2;s=Enabled',
        dataType: 'Boolean',
        draftState: 'inactive_review_required',
      }),
      expect.objectContaining({
        nodeId: 'ns=2;s=Mode',
        dataType: 'Int32',
        enumValues: [
          { value: 0, displayName: 'Off', suggestedLabel: 'off' },
          { value: 1, displayName: 'Production Run', suggestedLabel: 'production_run' },
        ],
      }),
      expect.objectContaining({
        nodeId: 'ns=2;s=Recipe',
        dataType: 'String',
        draftState: 'inactive_review_required',
      }),
    ]);
    for (const candidate of result.draftSemanticControls) {
      expect(candidate).not.toHaveProperty('riskLevel');
      expect(candidate).not.toHaveProperty('riskNote');
      expect(candidate).not.toHaveProperty('falseLabel');
      expect(candidate).not.toHaveProperty('trueLabel');
      expect(candidate).not.toHaveProperty('allowedValues');
    }
  });

  it.each([
    'Boolean',
    'SByte',
    'Byte',
    'Int16',
    'UInt16',
    'Int32',
    'UInt32',
    'Float',
    'Double',
    'String',
  ] as const)('supports scalar %s Variables, including absent shape metadata', (dataType) => {
    const node = writableNode(`ns=2;s=${dataType}`, {
      displayName: `${dataType} Setpoint`,
      dataType: supportedType(dataType),
    });
    delete node.valueShape;

    const result = generateDraftSemanticControlCandidates(discovery([node]));

    expect(result.draftSemanticControls).toEqual([
      expect.objectContaining({ dataType, draftState: 'inactive_review_required' }),
    ]);
  });

  it('deduplicates enum labels, Nodes, and generated names deterministically', () => {
    const duplicateName = (nodeId: string) =>
      writableNode(nodeId, {
        displayName: 'Speed Setpoint',
        dataType: supportedType('Double'),
      });
    const enumNode = writableNode('ns=2;s=Enum', {
      displayName: 'Mode',
      dataType: supportedType('Int32'),
      dataAccess: {
        enumValues: evidence([
          { value: 2, displayName: 'Production Run' },
          { value: 1, displayName: 'Production Run' },
          { value: 0, displayName: '0' },
        ]),
      },
    });
    const first = generateDraftSemanticControlCandidates(
      discovery([
        duplicateName('ns=2;s=B'),
        enumNode,
        duplicateName('ns=2;s=A'),
        duplicateName('ns=2;s=A'),
      ]),
    );
    const second = generateDraftSemanticControlCandidates(
      discovery([duplicateName('ns=2;s=A'), duplicateName('ns=2;s=B')]),
    );

    expect(
      first.draftSemanticControls
        .filter(({ nodeId }) => nodeId !== 'ns=2;s=Enum')
        .map(({ nodeId, suggestedName }) => ({ nodeId, suggestedName })),
    ).toEqual([
      { nodeId: 'ns=2;s=A', suggestedName: 'set_speed_setpoint' },
      { nodeId: 'ns=2;s=B', suggestedName: 'set_speed_setpoint_2' },
    ]);
    expect(
      first.draftSemanticControls.find(({ nodeId }) => nodeId === 'ns=2;s=Enum')?.enumValues,
    ).toEqual([
      { value: 2, displayName: 'Production Run', suggestedLabel: 'production_run' },
      { value: 1, displayName: 'Production Run', suggestedLabel: 'production_run_2' },
      { value: 0, displayName: '0', suggestedLabel: 'value_0' },
    ]);
    expect(first.draftSemanticControls.filter(({ nodeId }) => nodeId !== 'ns=2;s=Enum')).toEqual(
      second.draftSemanticControls,
    );
  });
});

function variable(
  input: CommissioningNode['identity'] &
    Pick<CommissioningNode, 'description' | 'dataType' | 'dataAccess'>,
): CommissioningNode {
  const { description, dataType, dataAccess, ...identity } = input;
  return {
    identity,
    nodeClass: evidence('Variable'),
    valueShape: { kind: 'scalar', evidence: evidence('scalar') },
    access: { writable: evidence(true), userAccess: evidence({ currentWrite: true }) },
    ...(description === undefined ? {} : { description }),
    ...(dataType === undefined ? {} : { dataType }),
    ...(dataAccess === undefined ? {} : { dataAccess }),
  };
}

function writableNode(
  nodeId: string,
  overrides: Omit<Partial<CommissioningNode>, 'identity'> &
    Partial<Omit<CommissioningNode['identity'], 'nodeId'>>,
): CommissioningNode {
  const { browseName, displayName, path, typeDefinition, ...nodeOverrides } = overrides;
  return {
    identity: {
      nodeId,
      ...(browseName === undefined ? {} : { browseName }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(path === undefined ? {} : { path }),
      ...(typeDefinition === undefined ? {} : { typeDefinition }),
    },
    nodeClass: evidence('Variable'),
    valueShape: { kind: 'scalar', evidence: evidence('scalar') },
    access: { writable: evidence(true), userAccess: evidence({ currentWrite: true }) },
    ...nodeOverrides,
  };
}

function supportedType(
  dataType: CommissioningSupportedControlDataType,
): NonNullable<CommissioningNode['dataType']> {
  return { opcuaName: dataType, mappedType: dataType, evidence: evidence(dataType) };
}

function discovery(nodes: CommissioningNode[]): CommissioningDiscoveryResult {
  return {
    generatedAt: '2026-07-13T00:00:00.000Z',
    roots: [],
    nodes,
    suggestedReadEntryPoints: [],
    draftSemanticControls: [],
    writableButNotSuggested: [],
    findings: { blocking: [], warnings: [] },
    coverage: {
      requestedRoots: 0,
      succeededRoots: 0,
      failedRoots: 0,
      nodesVisited: nodes.length,
      maxNodes: 100,
      depthRequested: 4,
      depthReached: 0,
      fields: {},
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
