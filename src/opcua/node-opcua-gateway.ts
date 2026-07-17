import { createRequire } from 'node:module';
import type { AppConfig } from '../config/schema.js';
import type {
  CommissioningDiscoveryGateway,
  CommissioningDiscoveryRequest,
  CommissioningDiscoveryResult,
} from '../commissioning/discovery.js';
import { discoverWithNodeOpcUa } from '../commissioning/node-opcua-discovery.js';
import type {
  BrowseNodeResult,
  NodeMetadataResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
  WriteValueResult,
} from './gateway.js';
import {
  WELL_KNOWN_OPC_UA_DATA_TYPES,
  WELL_KNOWN_OPC_UA_NODE_CLASSES,
} from './well-known-enums.js';

export interface OpcUaSessionLike {
  close(): Promise<void>;
  browse?(description: OpcUaBrowseDescription): Promise<OpcUaBrowseResponse>;
  browseNext?(
    continuationPoint: unknown,
    releaseContinuationPoints: boolean,
  ): Promise<OpcUaBrowseResponse>;
  read?(description: OpcUaReadDescription): Promise<OpcUaDataValueLike>;
  write?(description: OpcUaWriteDescription): Promise<unknown>;
}

export interface OpcUaReadDescription {
  nodeId: string;
  attributeId: number;
}

export interface OpcUaWriteDescription {
  nodeId: string;
  attributeId: 13;
  value: { value: { dataType: string; value: unknown } };
}

export interface OpcUaDataValueLike {
  value?: { dataType?: unknown; value?: unknown } | null;
  statusCode?: unknown;
  sourceTimestamp?: Date | string | null;
  serverTimestamp?: Date | string | null;
}

export interface OpcUaBrowseDescription {
  nodeId: string;
  browseDirection: 'Forward';
  referenceTypeId: 'HierarchicalReferences';
  includeSubtypes: true;
  resultMask: number;
}

export interface OpcUaBrowseResponse {
  references?: OpcUaReferenceLike[] | null;
  statusCode?: unknown;
  continuationPoint?: unknown;
}

export interface OpcUaReferenceLike {
  nodeId?: unknown;
  browseName?: unknown;
  displayName?: { text?: string } | string;
  nodeClass?: unknown;
  dataType?: unknown;
  typeDefinition?: unknown;
}

export interface OpcUaClientLike {
  connect(endpointUrl: string): Promise<void>;
  createSession(userIdentity?: OpcUaUserIdentity): Promise<OpcUaSessionLike>;
  disconnect(): Promise<void>;
}

export interface OpcUaUserIdentity {
  type: 'UserName';
  userName: string;
  password: string;
}

export interface NodeOpcUaGatewayOptions {
  connection: AppConfig['connection'];
  clientFactory?: (options: NodeOpcUaClientFactoryOptions) => OpcUaClientLike;
  now?: () => Date;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface NodeOpcUaClientFactoryOptions {
  securityMode: AppConfig['connection']['securityMode'];
  securityPolicy: string;
}

type Timer = ReturnType<typeof setTimeout>;

interface RealNodeOpcUaClient {
  connect(endpointUrl: string): Promise<void>;
  createSession(userIdentity?: unknown): Promise<OpcUaSessionLike>;
  disconnect(): Promise<void>;
}

interface NodeOpcUaModule {
  OPCUAClient: {
    create(options: Record<string, unknown>): RealNodeOpcUaClient;
  };
  MessageSecurityMode: Record<string, unknown>;
  SecurityPolicy: Record<string, unknown>;
  UserTokenType: { UserName: unknown };
  DataType: Record<number, string | undefined>;
  NodeClass: Record<number, string | undefined>;
}

const require = createRequire(import.meta.url);
let nodeOpcUaModule: NodeOpcUaModule | undefined;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const ATTRIBUTE_NODE_ID = 1;
const ATTRIBUTE_DATA_TYPE = 14;
const ATTRIBUTE_VALUE_RANK = 15;
const ATTRIBUTE_USER_ACCESS_LEVEL = 18;
const ACCESS_LEVEL_CURRENT_READ = 0x01;
const ACCESS_LEVEL_CURRENT_WRITE = 0x02;

export class NodeOpcUaGateway implements OpcUaGateway, CommissioningDiscoveryGateway {
  private readonly connection: AppConfig['connection'];
  private readonly clientFactory: (options: NodeOpcUaClientFactoryOptions) => OpcUaClientLike;
  private readonly now: () => Date;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private state: OpcUaStatus['state'] = 'disconnected';
  private lastSuccessfulHealthCheckAt: string | undefined;
  private lastError: OpcUaStatus['lastError'];
  private connectionGeneration = 0;
  private client: OpcUaClientLike | undefined;
  private session: OpcUaSessionLike | undefined;
  private started = false;
  private closed = false;
  private reconnectDelayMs: number;
  private reconnectTimer: Timer | undefined;
  private hasConnected = false;

  constructor(options?: NodeOpcUaGatewayOptions) {
    this.connection = options?.connection ?? {
      endpointUrl: '',
      securityMode: 'None',
      securityPolicy: 'None',
      auth: { type: 'anonymous' },
    };
    this.clientFactory = options?.clientFactory ?? createNodeOpcUaClient;
    this.now = options?.now ?? (() => new Date());
    this.initialReconnectDelayMs =
      options?.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options?.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.reconnectDelayMs = this.initialReconnectDelayMs;
  }

  status(): Promise<OpcUaStatus> {
    const status: OpcUaStatus = {
      state: this.state,
      connectionGeneration: this.connectionGeneration,
    };
    if (this.lastSuccessfulHealthCheckAt !== undefined)
      status.lastSuccessfulHealthCheckAt = this.lastSuccessfulHealthCheckAt;
    if (this.lastError !== undefined) status.lastError = this.lastError;
    return Promise.resolve(status);
  }

  connect(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.closed = false;
    this.state = 'connecting';
    void this.establishSession();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.closeSessionAndClient();
    this.state = 'disconnected';
  }

  async browse(nodeId: string, depth: number): Promise<BrowseNodeResult[]> {
    const session = this.session;
    if (session?.browse === undefined || this.state !== 'connected')
      throw new Error('OPC UA session is not connected.');

    const results: BrowseNodeResult[] = [];
    let frontier = [nodeId];
    const visited = new Set<string>([nodeId]);

    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const nextFrontier: string[] = [];
      for (const currentNodeId of frontier) {
        const response = await session.browse(buildBrowseDescription(currentNodeId));
        for (const reference of response.references ?? []) {
          const childNodeId = stringifyOpcUaValue(reference.nodeId);
          if (childNodeId === undefined) continue;
          results.push(mapReference(reference, childNodeId));
          if (!visited.has(childNodeId)) {
            visited.add(childNodeId);
            nextFrontier.push(childNodeId);
          }
        }
      }
      frontier = nextFrontier;
    }

    return results;
  }

  async read(nodeId: string): Promise<ReadValueResult> {
    const session = this.session;
    if (session?.read === undefined || this.state !== 'connected')
      throw new Error('OPC UA session is not connected.');

    const dataValue = await session.read({ nodeId, attributeId: 13 });
    return mapDataValue(nodeId, dataValue);
  }

  async readMany(nodeIds: string[]): Promise<ReadValueResult[]> {
    return Promise.all(nodeIds.map((nodeId) => this.read(nodeId)));
  }

  async write(nodeId: string, dataType: string, value: unknown): Promise<WriteValueResult> {
    const session = this.session;
    if (session?.write === undefined || this.state !== 'connected')
      throw new Error('OPC UA session is not connected.');

    const statusCode = await session.write({
      nodeId,
      attributeId: 13,
      value: { value: { dataType, value } },
    });
    return { opcuaStatus: stringifyOpcUaValue(statusCode) ?? 'Unknown' };
  }

  async discoverCommissioning(
    request: CommissioningDiscoveryRequest,
  ): Promise<CommissioningDiscoveryResult> {
    const session = this.session;
    if (session === undefined || this.state !== 'connected')
      throw new Error('OPC UA session is not connected.');
    return discoverWithNodeOpcUa(session, request, this.now);
  }

  async getNodeMetadata(nodeId: string): Promise<NodeMetadataResult> {
    const session = this.session;
    if (session?.browse === undefined || session.read === undefined || this.state !== 'connected') {
      throw new Error('OPC UA session is not connected.');
    }

    const [
      browse,
      nodeIdAttribute,
      dataTypeAttribute,
      valueRankAttribute,
      userAccessLevelAttribute,
    ] = await Promise.allSettled([
      session.browse(buildBrowseDescription(nodeId)),
      session.read({ nodeId, attributeId: ATTRIBUTE_NODE_ID }),
      session.read({ nodeId, attributeId: ATTRIBUTE_DATA_TYPE }),
      session.read({ nodeId, attributeId: ATTRIBUTE_VALUE_RANK }),
      session.read({ nodeId, attributeId: ATTRIBUTE_USER_ACCESS_LEVEL }),
    ]);

    const metadata: NodeMetadataResult = {
      exists:
        nodeIdAttribute.status === 'fulfilled' && isGoodStatus(nodeIdAttribute.value.statusCode),
      browseable: browse.status === 'fulfilled' && isGoodStatus(browse.value.statusCode),
      attributeStatuses: compactAttributeStatuses({
        browse: settledOpcUaStatus(browse),
        nodeId: settledOpcUaStatus(nodeIdAttribute),
        dataType: settledOpcUaStatus(dataTypeAttribute),
        valueRank: settledOpcUaStatus(valueRankAttribute),
        userAccessLevel: settledOpcUaStatus(userAccessLevelAttribute),
      }),
    };

    if (
      dataTypeAttribute.status === 'fulfilled' &&
      isGoodStatus(dataTypeAttribute.value.statusCode)
    ) {
      const dataType = stringifyDataType(dataTypeAttribute.value.value?.value);
      if (dataType !== undefined) metadata.dataType = dataType;
    }

    if (
      valueRankAttribute.status === 'fulfilled' &&
      isGoodStatus(valueRankAttribute.value.statusCode) &&
      typeof valueRankAttribute.value.value?.value === 'number'
    ) {
      metadata.valueRank = valueRankAttribute.value.value.value;
    }

    if (
      userAccessLevelAttribute.status === 'fulfilled' &&
      isGoodStatus(userAccessLevelAttribute.value.statusCode)
    ) {
      const userAccessLevel = userAccessLevelAttribute.value.value?.value;
      if (typeof userAccessLevel === 'number') {
        metadata.readable = (userAccessLevel & ACCESS_LEVEL_CURRENT_READ) !== 0;
        metadata.writable = (userAccessLevel & ACCESS_LEVEL_CURRENT_WRITE) !== 0;
      }
    }

    return metadata;
  }

  private async establishSession(): Promise<void> {
    if (this.closed) return;
    try {
      this.client = this.clientFactory({
        securityMode: this.connection.securityMode,
        securityPolicy: this.connection.securityPolicy,
      });
      await this.client.connect(this.connection.endpointUrl);
      this.session = await this.client.createSession(resolveUserIdentity(this.connection));
      this.state = 'connected';
      this.hasConnected = true;
      this.connectionGeneration += 1;
      this.lastSuccessfulHealthCheckAt = this.now().toISOString();
      this.lastError = undefined;
      this.reconnectDelayMs = this.initialReconnectDelayMs;
    } catch (error) {
      await this.closeSessionAndClient();
      this.lastError = sanitizeError(error, this.now());
      this.state = this.hasConnected ? 'reconnecting' : 'disconnected';
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.state = this.hasConnected ? 'reconnecting' : 'connecting';
      void this.establishSession();
    }, delay);
  }

  private async closeSessionAndClient(): Promise<void> {
    const session = this.session;
    const client = this.client;
    this.session = undefined;
    this.client = undefined;
    await Promise.allSettled([session?.close(), client?.disconnect()]);
  }
}

function buildBrowseDescription(nodeId: string): OpcUaBrowseDescription {
  return {
    nodeId,
    browseDirection: 'Forward',
    referenceTypeId: 'HierarchicalReferences',
    includeSubtypes: true,
    resultMask: 63,
  };
}

function mapReference(reference: OpcUaReferenceLike, nodeId: string): BrowseNodeResult {
  const result: BrowseNodeResult = { nodeId };
  const browseName = stringifyOpcUaValue(reference.browseName);
  const displayName = stringifyDisplayName(reference.displayName);
  const nodeClass = stringifyNodeClass(reference.nodeClass);
  const dataType = stringifyDataType(reference.dataType);
  if (browseName !== undefined) result.browseName = browseName;
  if (displayName !== undefined) result.displayName = displayName;
  if (nodeClass !== undefined) result.nodeClass = nodeClass;
  if (dataType !== undefined) result.dataType = dataType;
  return result;
}

function mapDataValue(nodeId: string, dataValue: OpcUaDataValueLike): ReadValueResult {
  const result: ReadValueResult = { nodeId, value: dataValue.value?.value };
  const dataType = stringifyDataType(dataValue.value?.dataType);
  const opcuaStatus = stringifyStatusCode(dataValue.statusCode);
  const sourceTimestamp = stringifyTimestamp(dataValue.sourceTimestamp);
  const serverTimestamp = stringifyTimestamp(dataValue.serverTimestamp);
  if (dataType !== undefined) result.dataType = dataType;
  if (opcuaStatus !== undefined) result.opcuaStatus = opcuaStatus;
  if (sourceTimestamp !== undefined) result.sourceTimestamp = sourceTimestamp;
  if (serverTimestamp !== undefined) result.serverTimestamp = serverTimestamp;
  return result;
}

function stringifyDisplayName(value: OpcUaReferenceLike['displayName']): string | undefined {
  if (typeof value === 'string') return value;
  if (value?.text !== undefined) return value.text;
  return undefined;
}

function stringifyTimestamp(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function stringifyOpcUaValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // OPC UA SDK identifier objects stringify to canonical NodeId/QualifiedName text.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  if (hasCustomToString(value)) return value.toString();
  return undefined;
}

function stringifyDataType(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return (
      WELL_KNOWN_OPC_UA_DATA_TYPES[value] ?? loadNodeOpcUaModule().DataType[value] ?? String(value)
    );
  }
  return stringifyOpcUaValue(value);
}

function stringifyNodeClass(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return (
      WELL_KNOWN_OPC_UA_NODE_CLASSES[value] ??
      loadNodeOpcUaModule().NodeClass[value] ??
      String(value)
    );
  }
  return stringifyOpcUaValue(value);
}

function loadNodeOpcUaModule(): NodeOpcUaModule {
  return (nodeOpcUaModule ??= require('node-opcua') as NodeOpcUaModule);
}

function stringifyStatusCode(value: unknown): string | undefined {
  if (hasStatusName(value)) return value.name;
  return stringifyOpcUaValue(value);
}

function settledOpcUaStatus(
  result: PromiseSettledResult<{ statusCode?: unknown }>,
): string | undefined {
  if (result.status === 'rejected') return undefined;
  return stringifyStatusCode(result.value.statusCode);
}

function compactAttributeStatuses(
  statuses: Record<keyof NonNullable<NodeMetadataResult['attributeStatuses']>, string | undefined>,
): NonNullable<NodeMetadataResult['attributeStatuses']> {
  return Object.fromEntries(
    Object.entries(statuses).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function isGoodStatus(value: unknown): boolean {
  return stringifyStatusCode(value)?.startsWith('Good') === true;
}

function hasStatusName(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
  );
}

function hasCustomToString(value: unknown): value is { toString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function' &&
    value.toString !== Object.prototype.toString
  );
}

function createNodeOpcUaClient(options: NodeOpcUaClientFactoryOptions): OpcUaClientLike {
  const nodeOpcUa = loadNodeOpcUaModule();
  const client = nodeOpcUa.OPCUAClient.create({
    applicationName: 'opcua-mcp-server',
    connectionStrategy: { maxRetry: 0 },
    endpointMustExist: false,
    securityMode: nodeOpcUa.MessageSecurityMode[options.securityMode],
    securityPolicy:
      options.securityPolicy === 'None'
        ? nodeOpcUa.SecurityPolicy['None']
        : nodeOpcUa.SecurityPolicy[options.securityPolicy],
  });

  return {
    connect: (endpointUrl) => client.connect(endpointUrl),
    disconnect: () => client.disconnect(),
    createSession: (userIdentity) =>
      client.createSession(
        userIdentity === undefined
          ? undefined
          : {
              type: nodeOpcUa.UserTokenType.UserName,
              userName: userIdentity.userName,
              password: userIdentity.password,
            },
      ),
  };
}

function resolveUserIdentity(connection: AppConfig['connection']): OpcUaUserIdentity | undefined {
  if (connection.auth.type === 'anonymous') return undefined;
  return {
    type: 'UserName',
    userName: resolveEnvRef(connection.auth.username),
    password: resolveEnvRef(connection.auth.password),
  };
}

function resolveEnvRef(ref: string): string {
  const envName = ref.slice(2, -1);
  const value = process.env[envName];
  if (value === undefined) throw new Error(`Environment variable ${envName} is not set.`);
  return value;
}

function sanitizeError(error: unknown, now: Date): NonNullable<OpcUaStatus['lastError']> {
  const message = error instanceof Error ? error.message : 'Unknown OPC UA connection error.';
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'opcua_connection_failed';
  return {
    code,
    message: message.split('\n')[0]?.slice(0, 500) ?? 'Unknown OPC UA connection error.',
    at: now.toISOString(),
  };
}
