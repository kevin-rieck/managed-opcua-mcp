import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/schema.js';
import {
  NodeOpcUaGateway,
  type OpcUaClientLike,
  type OpcUaSessionLike,
} from '../../src/opcua/node-opcua-gateway.js';

const anonymousConnection: AppConfig['connection'] = {
  endpointUrl: 'opc.tcp://example.invalid:4840',
  securityMode: 'None',
  securityPolicy: 'None',
  auth: { type: 'anonymous' },
};

describe('NodeOpcUaGateway commissioning discovery', () => {
  it('traverses forward hierarchical references deterministically without reading values', async () => {
    const browse = vi.fn(({ nodeId }: { nodeId: string }) => {
      const children: Record<
        string,
        { nodeId: string; browseName: string; displayName: string; nodeClass: number }[]
      > = {
        'ns=2;s=Machine': [
          { nodeId: 'ns=2;s=Machine.B', browseName: '2:B', displayName: 'B', nodeClass: 2 },
          { nodeId: 'ns=2;s=Machine.A', browseName: '2:A', displayName: 'A', nodeClass: 2 },
        ],
        'ns=2;s=Machine.A': [
          {
            nodeId: 'ns=2;s=Machine.A.Speed',
            browseName: '2:Speed',
            displayName: 'Speed',
            nodeClass: 2,
          },
        ],
      };
      return Promise.resolve({
        statusCode: { name: 'Good' },
        references: children[nodeId] ?? [],
      });
    });
    const read = vi.fn(({ nodeId, attributeId }: { nodeId: string; attributeId: number }) => {
      const leaf = nodeId.split('.').at(-1) ?? 'Machine';
      const values: Record<number, unknown> = {
        1: nodeId,
        2: nodeId === 'ns=2;s=Machine' ? 1 : 2,
        3: `2:${leaf}`,
        4: leaf,
        5: `${leaf} description`,
        14: 11,
        15: -1,
        16: [],
        17: 1,
        18: 1,
      };
      return Promise.resolve(
        attributeId in values
          ? { value: { value: values[attributeId] }, statusCode: { name: 'Good' } }
          : { statusCode: { name: 'BadAttributeIdInvalid' } },
      );
    });
    const gateway = await connectedGateway({ close: () => Promise.resolve(), browse, read });

    const result = await gateway.discoverCommissioning({
      roots: ['ns=2;s=Machine'],
      maxDepth: 2,
      maxNodes: 20,
    });

    expect(result.nodes.map((node) => node.identity)).toEqual([
      expect.objectContaining({ nodeId: 'ns=2;s=Machine', path: ['Machine'] }),
      expect.objectContaining({ nodeId: 'ns=2;s=Machine.A', path: ['Machine', 'A'] }),
      expect.objectContaining({
        nodeId: 'ns=2;s=Machine.A.Speed',
        path: ['Machine', 'A', 'Speed'],
      }),
      expect.objectContaining({ nodeId: 'ns=2;s=Machine.B', path: ['Machine', 'B'] }),
    ]);
    expect(browse).toHaveBeenCalledWith({
      nodeId: 'ns=2;s=Machine',
      browseDirection: 'Forward',
      referenceTypeId: 'HierarchicalReferences',
      includeSubtypes: true,
      resultMask: 63,
    });
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ attributeId: 13 }));
    expect(result.roots).toEqual([
      expect.objectContaining({
        nodeId: 'ns=2;s=Machine',
        status: 'succeeded',
        nodesVisited: 4,
        depthReached: 2,
      }),
    ]);
    expect(result.coverage).toMatchObject({
      requestedRoots: 1,
      succeededRoots: 1,
      failedRoots: 0,
      nodesVisited: 4,
      depthReached: 2,
    });
  });

  it('stops at the global Node cap and reports partial root coverage', async () => {
    const session = metadataSession({
      'ns=2;s=Machine': [
        reference('ns=2;s=Machine.B', 'B'),
        reference('ns=2;s=Machine.A', 'A'),
        reference('ns=2;s=Machine.C', 'C'),
      ],
    });
    const gateway = await connectedGateway(session);

    const result = await gateway.discoverCommissioning({
      roots: ['ns=2;s=Machine'],
      maxDepth: 3,
      maxNodes: 2,
    });

    expect(result.nodes.map((node) => node.identity.nodeId)).toEqual([
      'ns=2;s=Machine',
      'ns=2;s=Machine.A',
    ]);
    expect(result.roots[0]).toMatchObject({ status: 'partial', nodesVisited: 2 });
    expect(result.findings.warnings).toContainEqual(
      expect.objectContaining({ code: 'max_nodes_reached', area: 'ns=2;s=Machine' }),
    );

    const depthGateway = await connectedGateway(
      metadataSession({
        'ns=2;s=Machine': [reference('ns=2;s=Machine.A', 'A')],
      }),
    );
    const depthResult = await depthGateway.discoverCommissioning({
      roots: ['ns=2;s=Machine'],
      maxDepth: 0,
      maxNodes: 10,
    });

    expect(depthResult.nodes.map((node) => node.identity.nodeId)).toEqual(['ns=2;s=Machine']);
    expect(depthResult.roots[0]).toMatchObject({ status: 'partial', depthReached: 0 });
    expect(depthResult.findings.warnings).toContainEqual(
      expect.objectContaining({ code: 'max_depth_reached', area: 'ns=2;s=Machine' }),
    );
    await expect(
      depthGateway.discoverCommissioning({ roots: [], maxDepth: 11, maxNodes: 10 }),
    ).rejects.toThrow('maxDepth');
    await expect(
      depthGateway.discoverCommissioning({ roots: [], maxDepth: 1, maxNodes: 1_001 }),
    ).rejects.toThrow('maxNodes');

    const defaultRootGateway = await connectedGateway(metadataSession({}));
    const defaultRootResult = await defaultRootGateway.discoverCommissioning({ roots: [] });
    expect(defaultRootResult.roots[0]?.nodeId).toBe('ns=0;i=85');
    expect(defaultRootResult.coverage).toMatchObject({ maxNodes: 1_000, depthRequested: 4 });
    expect(defaultRootResult.suggestedReadEntryPoints[0]?.reason).toBe('high_level_object');
  });

  it('follows browse continuations and reads standard Data Access Property values as metadata', async () => {
    const browseNext = vi.fn(() =>
      Promise.resolve({
        statusCode: { name: 'Good' },
        references: [reference('ns=2;s=Setpoint.EnumStrings', 'EnumStrings')],
      }),
    );
    const read = vi.fn(({ nodeId, attributeId }: { nodeId: string; attributeId: number }) => {
      if (attributeId === 13) {
        const propertyValues: Record<string, unknown> = {
          'ns=2;s=Setpoint.EngineeringUnits': { displayName: { text: 'rpm' }, unitId: 1 },
          'ns=2;s=Setpoint.EURange': { low: 0, high: 1800 },
          'ns=2;s=Setpoint.EnumStrings': [{ text: 'Off' }, { text: 'On' }],
        };
        return Promise.resolve({
          value: { value: propertyValues[nodeId] },
          statusCode: { name: 'Good' },
        });
      }
      const values: Record<number, unknown> = {
        2: 2,
        3: '2:Setpoint',
        4: 'Setpoint',
        5: 'Speed setpoint',
        14: 11,
        15: -1,
        16: [],
        17: 3,
        18: 3,
      };
      return Promise.resolve({
        value: { value: values[attributeId] },
        statusCode: { name: 'Good' },
      });
    });
    const gateway = await connectedGateway({
      close: () => Promise.resolve(),
      browse: () =>
        Promise.resolve({
          statusCode: { name: 'Good' },
          continuationPoint: new Uint8Array([1]),
          references: [
            reference('ns=2;s=Setpoint.EngineeringUnits', 'EngineeringUnits'),
            reference('ns=2;s=Setpoint.EURange', 'EURange'),
          ],
        }),
      browseNext,
      read,
    });

    const result = await gateway.discoverCommissioning({
      roots: ['ns=2;s=Setpoint'],
      maxDepth: 0,
      maxNodes: 10,
    });

    expect(browseNext).toHaveBeenCalledWith(new Uint8Array([1]), false);
    expect(result.nodes[0]?.dataAccess).toMatchObject({
      engineeringUnits: { value: { displayName: 'rpm', unitId: 1 } },
      euRange: { value: { low: 0, high: 1800 } },
      enumStrings: { value: ['Off', 'On'] },
    });
    expect(result.draftSemanticControls).toEqual([
      expect.objectContaining({
        nodeId: 'ns=2;s=Setpoint',
        suggestedName: 'set_setpoint',
        dataType: 'Double',
        unit: 'rpm',
        normalRange: { low: 0, high: 1800 },
        draftState: 'inactive_review_required',
      }),
    ]);
    expect(
      read.mock.calls
        .filter((call) => call[0].attributeId === 13)
        .map((call) => call[0].nodeId)
        .sort(),
    ).toEqual([
      'ns=2;s=Setpoint.EURange',
      'ns=2;s=Setpoint.EngineeringUnits',
      'ns=2;s=Setpoint.EnumStrings',
    ]);
  });

  it('preserves access denial and partial metadata failures as structured findings', async () => {
    const denied = metadataSession({}, { browseStatus: 'BadUserAccessDenied' });
    const deniedGateway = await connectedGateway(denied);

    const deniedResult = await deniedGateway.discoverCommissioning({
      roots: ['ns=2;s=Denied'],
      maxDepth: 1,
      maxNodes: 10,
    });

    expect(deniedResult.roots[0]).toMatchObject({
      status: 'failed',
      statusDetail: { severity: 'bad', code: 'BadUserAccessDenied' },
    });
    expect(deniedResult.findings.blocking).toContainEqual(
      expect.objectContaining({ code: 'root_browse_failed', area: 'ns=2;s=Denied' }),
    );

    const partial = metadataSession(
      { 'ns=2;s=Machine': [reference('ns=2;s=Machine.Speed', 'Speed')] },
      { failedField: { nodeId: 'ns=2;s=Machine.Speed', attributeId: 14 } },
    );
    const partialGateway = await connectedGateway(partial);
    const partialResult = await partialGateway.discoverCommissioning({
      roots: ['ns=2;s=Machine'],
      maxDepth: 1,
      maxNodes: 10,
    });

    expect(partialResult.nodes).toHaveLength(2);
    expect(partialResult.nodes[1]?.partialFailures).toContainEqual({
      field: 'DataType',
      status: { severity: 'bad', code: 'BadUserAccessDenied' },
    });
    expect(partialResult.findings.warnings).toContainEqual(
      expect.objectContaining({ code: 'metadata_read_failed', area: 'ns=2;s=Machine.Speed' }),
    );
  });
});

function reference(nodeId: string, name: string) {
  return { nodeId, browseName: `2:${name}`, displayName: name, nodeClass: 2 };
}

function metadataSession(
  children: Record<string, ReturnType<typeof reference>[]>,
  options: {
    browseStatus?: string;
    failedField?: { nodeId: string; attributeId: number };
  } = {},
): OpcUaSessionLike {
  return {
    close: () => Promise.resolve(),
    browse: ({ nodeId }) =>
      Promise.resolve({
        statusCode: { name: options.browseStatus ?? 'Good' },
        references: children[nodeId] ?? [],
      }),
    read: ({ nodeId, attributeId }) => {
      if (
        options.failedField?.nodeId === nodeId &&
        options.failedField.attributeId === attributeId
      ) {
        return Promise.resolve({ statusCode: { name: 'BadUserAccessDenied' } });
      }
      const name = nodeId.split('.').at(-1) ?? 'Machine';
      const isRoot = !nodeId.includes('.');
      const values: Record<number, unknown> = {
        2: isRoot ? 1 : 2,
        3: `2:${name}`,
        4: name,
        5: `${name} description`,
        14: 11,
        15: -1,
        16: [],
        17: 1,
        18: 1,
      };
      return Promise.resolve({
        value: { value: values[attributeId] },
        statusCode: { name: 'Good' },
      });
    },
  };
}

async function connectedGateway(session: OpcUaSessionLike): Promise<NodeOpcUaGateway> {
  const client: OpcUaClientLike = {
    connect: () => Promise.resolve(),
    createSession: () => Promise.resolve(session),
    disconnect: () => Promise.resolve(),
  };
  const gateway = new NodeOpcUaGateway({
    connection: anonymousConnection,
    clientFactory: () => client,
    now: () => new Date('2026-07-13T00:00:00.000Z'),
  });
  await gateway.connect();
  await Promise.resolve();
  await Promise.resolve();
  return gateway;
}
