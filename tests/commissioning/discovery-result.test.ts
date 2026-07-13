import { describe, expect, it } from 'vitest';
import type {
  CommissioningDiscoveryGateway,
  CommissioningDiscoveryResult,
} from '../../src/commissioning/discovery.js';

describe('commissioning discovery result seam', () => {
  it('lets command/report workflows consume fake commissioning results without node-opcua details', async () => {
    const result: CommissioningDiscoveryResult = {
      generatedAt: '2026-07-10T00:00:00.000Z',
      roots: [
        {
          nodeId: 'ns=2;s=Machine',
          status: 'succeeded',
          nodesVisited: 2,
          depthReached: 1,
        },
      ],
      nodes: [
        {
          identity: {
            nodeId: 'ns=2;s=Machine.SpeedSetpoint',
            browseName: '2:SpeedSetpoint',
            displayName: 'Speed Setpoint',
          },
          nodeClass: evidence('Variable'),
          description: evidence('Motor speed setpoint'),
          valueShape: {
            kind: 'scalar',
            evidence: evidence('scalar'),
          },
          dataType: {
            opcuaName: 'Double',
            mappedType: 'Double',
            evidence: evidence('Double'),
          },
          access: {
            readable: evidence(true),
            writable: evidence(true),
            userAccess: evidence({ currentRead: true, currentWrite: true }),
          },
          dataAccess: {
            engineeringUnits: evidence({ displayName: 'rpm' }),
            euRange: evidence({ low: 0, high: 1800 }),
          },
        },
      ],
      suggestedReadEntryPoints: [
        {
          nodeId: 'ns=2;s=Machine',
          suggestedLabel: 'machine',
          reason: 'requested_root',
          evidence: [evidence('browse_succeeded')],
        },
      ],
      draftSemanticControls: [
        {
          nodeId: 'ns=2;s=Machine.SpeedSetpoint',
          suggestedName: 'set_machine_speed_setpoint',
          dataType: 'Double',
          draftState: 'inactive_review_required',
          eligibility: 'eligible',
          reasons: ['scalar_supported_data_type', 'session_writable'],
          evidence: [evidence('candidate')],
        },
      ],
      writableButNotSuggested: [],
      findings: {
        blocking: [],
        warnings: [
          {
            code: 'range_requires_operator_confirmation',
            area: 'ns=2;s=Machine.SpeedSetpoint',
            message: 'EURange was found but is not an approved process bound.',
            evidence: [evidence('EURange')],
          },
        ],
      },
      coverage: {
        requestedRoots: 1,
        succeededRoots: 1,
        failedRoots: 0,
        nodesVisited: 2,
        maxNodes: 100,
        depthRequested: 1,
        depthReached: 1,
        fields: {
          Description: { succeeded: 1, failed: 0, notPresent: 0 },
          UserAccessLevel: { succeeded: 1, failed: 0, notPresent: 0 },
        },
      },
    };
    const gateway: CommissioningDiscoveryGateway = {
      discoverCommissioning: () => Promise.resolve(result),
    };

    await expect(
      gateway.discoverCommissioning({ roots: ['ns=2;s=Machine'], maxDepth: 1, maxNodes: 100 }),
    ).resolves.toMatchObject({
      draftSemanticControls: [{ suggestedName: 'set_machine_speed_setpoint' }],
      findings: { warnings: [{ code: 'range_requires_operator_confirmation' }] },
    });
  });
});

function evidence<T>(value: T) {
  return {
    value,
    source: 'metadata_read' as const,
    status: { severity: 'good' as const, code: 'Good' },
  };
}
