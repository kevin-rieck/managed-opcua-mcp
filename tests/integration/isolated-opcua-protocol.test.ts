import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditRecord, AuditSink } from '../../src/audit/audit-sink.js';
import { appConfigSchema } from '../../src/config/schema.js';
import { createMcpServer } from '../../src/mcp/server.js';
import {
  NodeOpcUaGateway,
  type OpcUaClientLike,
  type OpcUaSessionLike,
} from '../../src/opcua/node-opcua-gateway.js';

// The SDK's published SessionContext declarations conflict with exactOptionalPropertyTypes.
// Keep the runtime SDK real without importing that incompatible declaration graph.
interface CertificateManager {
  automaticallyAcceptUnknownCertificate: boolean;
  referenceCounter: number;
  initialize(): Promise<void>;
  trustCertificate(certificate: Buffer): Promise<void>;
  dispose(): Promise<void>;
}
interface Channel {
  securityMode: number;
  securityPolicy: string;
  send_response(
    type: string,
    response: object,
    message: object,
    callback?: (error?: Error) => void,
  ): void;
  close(): void;
}
interface Server {
  engine: {
    getSessions(): { authenticationToken: object }[];
    closeSession(token: object, deleteSubscriptions: boolean, reason: 'Forcing'): void;
    browseWithAutomaticExpansion(
      nodes: { nodeId: { toString(): string } }[],
      context: { checkPermission(node: object, permission: number): boolean },
    ): Promise<object[]>;
    addressSpace?: {
      getOwnNamespace(): {
        addVariable(options: {
          [key: string]: unknown;
          value: {
            get?: () => object;
            set?: (value: { value: unknown }) => object;
            timestamped_get?: () => object;
          };
        }): void;
        addObject(options: Record<string, unknown>): object;
      };
      rootFolder: { objects: unknown };
    };
  };
  endpoints: { port: number; getCertificate(): Buffer; getChannels(): Channel[] }[];
  initialize(): Promise<void>;
  start(): Promise<void>;
  shutdown(delay: number): Promise<void>;
  on(event: 'request', listener: (request: object, channel: Channel) => void): void;
  off(event: 'request', listener: (request: object, channel: Channel) => void): void;
}
interface SdkClient {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  createSession(
    identity: { type: number; userName: string; password: string } | undefined,
  ): Promise<OpcUaSessionLike & { on(event: 'session_restored', listener: () => void): void }>;
}
const {
  BrowseResult,
  DataType,
  DataValue,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  OPCUAServer,
  PermissionType,
  SecurityPolicy,
  StatusCodes,
  UserTokenType,
  Variant,
  WellKnownRoles,
  makeNodeId,
} = createRequire(import.meta.url)('node-opcua') as {
  BrowseResult: new (options: object) => object;
  DataType: { Int32: number };
  DataValue: new (options: object) => object;
  MessageSecurityMode: { None: number; SignAndEncrypt: number };
  OPCUACertificateManager: new (options: object) => CertificateManager;
  OPCUAClient: { create(options: object): SdkClient };
  OPCUAServer: new (options: object) => Server;
  PermissionType: { Browse: number; Read: number; Write: number };
  SecurityPolicy: { None: string; Basic256Sha256: string };
  StatusCodes: {
    Good: object;
    Uncertain: object;
    BadUserAccessDenied: object;
    BadNodeIdUnknown: { value: number };
  };
  UserTokenType: { UserName: number };
  Variant: new (options: object) => object;
  WellKnownRoles: { Observer: number; Operator: number };
  makeNodeId: (value: number) => object;
};

const { CertificateManager: PkiCertificateManager } = createRequire(import.meta.url)(
  'node-opcua-pki',
) as { CertificateManager: { checkAllDisposed(): void } };

const readerRole = makeNodeId(WellKnownRoles.Observer);
const writerRole = makeNodeId(WellKnownRoles.Operator);
const target = 'ns=1;s=target';
const readonly = 'ns=1;s=readonly';
const uncertain = 'ns=1;s=uncertain';
const uncertainWrite = 'ns=1;s=uncertain-write';
const hidden = 'ns=1;s=hidden';
const statuses = {
  good: { value: 0, hex: '0x00000000', name: 'Good' },
  denied: { value: 0x801f0000, hex: '0x801f0000', name: 'BadUserAccessDenied' },
  notWritable: { value: 0x803b0000, hex: '0x803b0000', name: 'BadNotWritable' },
  uncertain: { value: 0x40000000, hex: '0x40000000', name: 'Uncertain' },
};

describe('isolated real OPC UA protocol', () => {
  let dir: string;
  let server: Server;
  let endpoint: string;
  let value = 1;
  let mutations = 0;
  let uncertainWrites = 0;
  const requests: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opcua-protocol-'));
    const serverManager = new OPCUACertificateManager({
      rootFolder: join(dir, 'server'),
      automaticallyAcceptUnknownCertificate: true,
      disableFileWatchers: true,
    });
    server = new OPCUAServer({
      port: 0,
      host: '127.0.0.1',
      hostname: '127.0.0.1',
      alternateHostname: ['127.0.0.1'],
      serverCertificateManager: serverManager,
      userCertificateManager: serverManager,
      allowAnonymous: false,
      securityModes: [MessageSecurityMode.None, MessageSecurityMode.SignAndEncrypt],
      securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
      userManager: {
        isValidUser: (name: string, password: string) =>
          ['reader', 'writer'].includes(name) && password === 'test',
        getUserRoles: (name: string) => [name === 'reader' ? readerRole : writerRole],
      },
    });
    await server.initialize();
    const addressSpace = server.engine.addressSpace;
    if (!addressSpace) throw new Error('Missing address space');
    const ns = addressSpace.getOwnNamespace();
    const permissions = [
      { roleId: readerRole, permissions: PermissionType.Browse | PermissionType.Read },
      { roleId: writerRole, permissions: PermissionType.Browse | PermissionType.Write },
    ];
    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      nodeId: target,
      browseName: 'target',
      minimumSamplingInterval: 0,
      dataType: 'Int32',
      rolePermissions: permissions,
      value: {
        get: () => new Variant({ dataType: DataType.Int32, value }),
        set: (variant) => {
          value = variant.value as number;
          mutations++;
          return StatusCodes.Good;
        },
      },
    });
    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      nodeId: readonly,
      browseName: 'readonly',
      minimumSamplingInterval: 0,
      dataType: 'Int32',
      accessLevel: 'CurrentRead',
      rolePermissions: permissions,
      value: { get: () => new Variant({ dataType: DataType.Int32, value: 2 }) },
    });
    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      nodeId: uncertain,
      browseName: 'uncertain',
      minimumSamplingInterval: 0,
      dataType: 'Int32',
      rolePermissions: permissions,
      value: {
        timestamped_get: () =>
          new DataValue({
            value: new Variant({ dataType: DataType.Int32, value: 42 }),
            statusCode: StatusCodes.Uncertain,
          }),
      },
    });
    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      nodeId: uncertainWrite,
      browseName: 'uncertain-write',
      minimumSamplingInterval: 0,
      dataType: 'Int32',
      rolePermissions: permissions,
      value: {
        get: () => new Variant({ dataType: DataType.Int32, value: 0 }),
        set: () => {
          uncertainWrites++;
          return StatusCodes.Uncertain;
        },
      },
    });
    const hiddenNode = ns.addObject({
      organizedBy: addressSpace.rootFolder.objects,
      nodeId: hidden,
      browseName: 'hidden',
      rolePermissions: [{ roleId: writerRole, permissions: PermissionType.Browse }],
    });
    // This fixture returns an explicit denial; node-opcua normally filters references instead.
    const browse = server.engine.browseWithAutomaticExpansion.bind(server.engine);
    server.engine.browseWithAutomaticExpansion = (nodes, context) => {
      if (
        nodes.length === 1 &&
        nodes[0]?.nodeId.toString() === hidden &&
        !context.checkPermission(hiddenNode, PermissionType.Browse)
      ) {
        return Promise.resolve([new BrowseResult({ statusCode: StatusCodes.BadUserAccessDenied })]);
      }
      return browse(nodes, context);
    };
    server.on('request', (request) => requests.push(request.constructor.name));
    await server.start();
    const port = server.endpoints[0]?.port;
    if (!port) throw new Error('Server did not allocate a port');
    endpoint = `opc.tcp://127.0.0.1:${String(port)}`;
    vi.stubEnv('ISOLATED_OPCUA_USER', 'reader');
    vi.stubEnv('ISOLATED_OPCUA_PASSWORD', 'test');
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    try {
      // Setup can fail before server construction.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (server) await server.shutdown(0);
      PkiCertificateManager.checkAllDisposed();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  async function disposeManager(cm: CertificateManager) {
    while (cm.referenceCounter > 0) await cm.dispose();
    await cm.dispose();
  }

  function manager(name: string) {
    return new OPCUACertificateManager({
      rootFolder: join(dir, name),
      automaticallyAcceptUnknownCertificate: false,
      disableFileWatchers: true,
    });
  }

  function config(secure = false) {
    return appConfigSchema.parse({
      version: 2,
      connection: {
        endpointUrl: endpoint,
        securityMode: secure ? 'SignAndEncrypt' : 'None',
        securityPolicy: secure ? 'Basic256Sha256' : 'None',
        auth: {
          type: 'usernamePassword',
          username: '${ISOLATED_OPCUA_USER}',
          password: '${ISOLATED_OPCUA_PASSWORD}',
        },
      },
      audit: { file: 'unused' },
    });
  }

  async function connect(name: string, clientFactory?: () => OpcUaClientLike) {
    const cfg = config();
    const cm = manager(name);
    const gateway = new NodeOpcUaGateway({
      connection: cfg.connection,
      certificateManager: cm,
      ...(clientFactory ? { clientFactory } : {}),
    });
    const records: AuditRecord[] = [];
    const sink: AuditSink = {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => {
        records.push(record);
        return Promise.resolve({ id: record.id });
      },
    };
    const mcp = createMcpServer({ config: cfg, configHash: 'test', gateway, auditSink: sink });
    const client = new Client({ name: 'isolated-protocol', version: '1' });
    try {
      await gateway.connect();
      await vi.waitFor(async () => expect((await gateway.status()).state).toBe('connected'), {
        timeout: 30_000,
        interval: 50,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), mcp.connect(b)]);
    } catch (error) {
      await Promise.allSettled([client.close(), mcp.close(), gateway.close()]);
      await disposeManager(cm);
      throw error;
    }
    return {
      client,
      records,
      close: async () => {
        const results = await Promise.allSettled([client.close(), mcp.close(), gateway.close()]);
        await disposeManager(cm);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected')
          throw new Error('Fixture cleanup failed', { cause: failure.reason as unknown });
      },
    };
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 30_000,
    });
    expect(response.isError).not.toBe(true);
    const content = response.content as { text: string }[];
    if (!content[0]) throw new Error('Missing tool response');
    return JSON.parse(content[0].text) as Record<string, unknown>;
  }

  it('enforces principal permissions and preserves write, read, browse and batch results', async () => {
    process.env['ISOLATED_OPCUA_USER'] = 'reader';
    const reader = await connect('reader');
    try {
      const denied = await call(reader.client, 'write_node', {
        nodeId: target,
        dataType: 'Int32',
        value: 9,
      });
      expect(denied).toMatchObject({
        ok: false,
        mutation: { outcome: 'rejected', statusCode: statuses.denied },
      });
      expect(reader.records.at(-1)).toMatchObject({
        event: 'write.completion',
        mutation: { outcome: 'rejected', statusCode: statuses.denied },
      });
      expect(mutations).toBe(0);
      expect(await call(reader.client, 'browse_node', { nodeId: hidden, depth: 1 })).toMatchObject({
        ok: false,
        statusCode: statuses.denied,
      });
      expect(
        await call(reader.client, 'browse_node', { nodeId: 'ns=1;s=missing', depth: 1 }),
      ).toMatchObject({ ok: false, statusCode: { value: StatusCodes.BadNodeIdUnknown.value } });
      expect(await call(reader.client, 'read_node', { nodeId: uncertain })).toMatchObject({
        ok: true,
        result: { value: 42, statusCode: statuses.uncertain },
      });
    } finally {
      await reader.close();
    }
    process.env['ISOLATED_OPCUA_USER'] = 'writer';
    const writer = await connect('writer');
    try {
      requests.length = 0;
      const written = await call(writer.client, 'write_node', {
        nodeId: target,
        dataType: 'Int32',
        value: 17,
      });
      expect(written).toMatchObject({
        ok: true,
        mutation: { outcome: 'accepted', statusCode: statuses.good },
      });
      expect(writer.records.at(-1)).toMatchObject({
        event: 'write.completion',
        mutation: { outcome: 'accepted', statusCode: statuses.good },
      });
      expect(requests.filter((name) => name === 'ReadRequest')).toHaveLength(0);
      expect(requests.filter((name) => name === 'WriteRequest')).toHaveLength(1);
      expect(value).toBe(17);
      expect(mutations).toBe(1);
      requests.length = 0;
      const unconfirmed = await call(writer.client, 'write_node', {
        nodeId: uncertainWrite,
        dataType: 'Int32',
        value: 5,
      });
      const unknown = {
        outcome: 'unknown',
        error: { code: 'write_outcome_unknown', statusCode: statuses.uncertain },
      };
      expect(unconfirmed).toMatchObject({ ok: false, mutation: unknown });
      expect(writer.records.at(-1)).toMatchObject({ event: 'write.completion', mutation: unknown });
      expect(uncertainWrites).toBe(1);
      expect(requests.filter((name) => name === 'WriteRequest')).toHaveLength(1);
      expect(await call(writer.client, 'read_node', { nodeId: target })).toMatchObject({
        ok: false,
        statusCode: statuses.denied,
      });
      const notWritable = await call(writer.client, 'write_node', {
        nodeId: readonly,
        dataType: 'Int32',
        value: 3,
      });
      expect(notWritable).toMatchObject({
        ok: false,
        mutation: { outcome: 'rejected', statusCode: statuses.notWritable },
      });
      expect(writer.records.at(-1)).toMatchObject({
        event: 'write.completion',
        mutation: { outcome: 'rejected', statusCode: statuses.notWritable },
      });
      const batch = await call(writer.client, 'read_nodes', {
        identifiers: [{ nodeId: target }, { nodeId: 'i=2258' }],
      });
      expect(batch).toMatchObject({
        ok: false,
        results: [
          { ok: false, statusCode: statuses.denied },
          { ok: true, nodeId: 'i=2258' },
        ],
      });
    } finally {
      await writer.close();
    }
  }, 120_000);

  it('does not retry an actual BadSessionIdInvalid service response', async () => {
    process.env['ISOLATED_OPCUA_USER'] = 'writer';
    const writer = await connect('invalid-session');
    try {
      const session = server.engine.getSessions()[0];
      if (!session) throw new Error('Missing server session');
      server.engine.closeSession(session.authenticationToken, true, 'Forcing');
      requests.length = 0;
      const before = mutations;
      const result = await call(writer.client, 'write_node', {
        nodeId: target,
        dataType: 'Int32',
        value: 28,
      });
      expect(result).toMatchObject({
        ok: false,
        mutation: {
          outcome: 'unknown',
          error: {
            code: 'opcua_service_error',
            statusCode: { value: 0x80250000, hex: '0x80250000', name: 'BadSessionIdInvalid' },
          },
        },
      });
      expect(writer.records.at(-1)).toMatchObject({
        event: 'write.completion',
        mutation: { outcome: 'unknown', error: { statusCode: { value: 0x80250000 } } },
      });
      expect(requests.filter((name) => name === 'WriteRequest')).toHaveLength(1);
      expect(mutations).toBe(before);
    } finally {
      await writer.close();
    }
  }, 120_000);

  it('does not replay an applied write whose response is lost during SDK session restoration', async () => {
    process.env['ISOLATED_OPCUA_USER'] = 'writer';
    const cm = manager('reconnect');
    try {
      const sdk = OPCUAClient.create({
        clientCertificateManager: cm,
        securityMode: MessageSecurityMode.None,
        securityPolicy: SecurityPolicy.None,
        connectionStrategy: {
          maxRetry: 10,
          initialDelay: 100,
          maxDelay: 500,
          randomisationFactor: 0,
        },
        endpointMustExist: false,
      });
      let restored = 0;
      const factory = (): OpcUaClientLike => ({
        connect: (url) => sdk.connect(url),
        disconnect: () => sdk.disconnect(),
        createSession: async (identity) => {
          const session = await sdk.createSession(
            identity && {
              type: UserTokenType.UserName,
              userName: identity.userName,
              password: identity.password,
            },
          );
          session.on('session_restored', () => {
            restored++;
          });
          return session;
        },
      });
      const writer = await connect('unused-reconnect', factory);
      let dropped = false;
      let appliedBeforeDrop = false;
      const intercept: (request: object, channel: Channel) => void = (request, channel) => {
        if (request.constructor.name !== 'WriteRequest' || dropped) return;
        const send = channel.send_response.bind(channel);
        channel.send_response = (type, response, message, callback) => {
          if (response.constructor.name === 'WriteResponse') {
            dropped = true;
            appliedBeforeDrop = value === 29 && mutations === before + 1;
            channel.send_response = send;
            channel.close();
            return;
          }
          send(type, response, message, callback);
        };
      };
      server.on('request', intercept);
      const before = mutations;
      requests.length = 0;
      try {
        const result = await call(writer.client, 'write_node', {
          nodeId: target,
          dataType: 'Int32',
          value: 29,
        });
        expect(result).toMatchObject({ ok: false, mutation: { outcome: 'unknown' } });
        expect(writer.records.at(-1)).toMatchObject({
          event: 'write.completion',
          mutation: { outcome: 'unknown' },
        });
        await vi.waitFor(() => expect(restored).toBeGreaterThan(0), {
          timeout: 30_000,
          interval: 50,
        });
        expect(await call(writer.client, 'read_node', { nodeId: 'i=2258' })).toMatchObject({
          ok: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(dropped).toBe(true);
        expect(appliedBeforeDrop).toBe(true);
        expect(mutations - before).toBe(1);
        expect(value).toBe(29);
        expect(requests.filter((name) => name === 'WriteRequest')).toHaveLength(1);
      } finally {
        server.off('request', intercept);
        await writer.close();
      }
    } finally {
      await disposeManager(cm);
    }
  }, 120_000);

  it('rejects an untrusted secure endpoint and connects only after explicit trust', async () => {
    process.env['ISOLATED_OPCUA_USER'] = 'reader';
    const cm = manager('secure');
    try {
      const cfg = config(true);
      const gateway = new NodeOpcUaGateway({
        connection: cfg.connection,
        certificateManager: cm,
        reconnect: { initialDelayMs: 60_000 },
      });
      try {
        await gateway.connect();
        await vi.waitFor(async () => expect((await gateway.status()).lastError).toBeDefined(), {
          timeout: 30_000,
          interval: 50,
        });
        expect((await gateway.status()).state).toBe('disconnected');
        expect((await gateway.status()).lastError?.message).toContain('BadCertificateUntrusted');
        expect(server.engine.getSessions()).toHaveLength(0);
      } finally {
        await gateway.close();
      }
      const certificate = server.endpoints[0]?.getCertificate();
      if (!certificate) throw new Error('Missing server certificate');
      await cm.initialize();
      await cm.trustCertificate(certificate);
      const trusted = new NodeOpcUaGateway({ connection: cfg.connection, certificateManager: cm });
      try {
        await trusted.connect();
        await vi.waitFor(async () => expect((await trusted.status()).state).toBe('connected'), {
          timeout: 30_000,
          interval: 50,
        });
        expect(await trusted.read(target)).toMatchObject({ value });
        const channels = server.endpoints[0]?.getChannels() ?? [];
        expect(
          channels.some(
            (channel) =>
              channel.securityMode === MessageSecurityMode.SignAndEncrypt &&
              channel.securityPolicy === SecurityPolicy.Basic256Sha256,
          ),
        ).toBe(true);
      } finally {
        await trusted.close();
      }
      expect(cm.referenceCounter).toBeGreaterThan(0);
    } finally {
      await disposeManager(cm);
    }
  }, 120_000);
});
