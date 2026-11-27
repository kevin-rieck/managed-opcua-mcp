import { createRequire } from 'node:module';
import {
  mapStatusCode,
  OpcUaStatusError,
  serviceStatusFromError,
  serviceStatusFromResponse,
  statusSeverity,
} from './status-code.js';
import {
  parseNativeNodeId,
  validateNativeScalar,
  type NativeDataType,
  type NativeNodeId,
  type NativeScalar,
} from './native-encoding.js';
import type { AppConfig } from '../config/schema.js';
import type {
  BrowseNodeResult,
  NodeMetadataResult,
  NativeWriteResult,
  OpcUaGateway,
  OpcUaStatus,
  ReadValueResult,
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
  write?(description: {
    nodeId: string;
    attributeId: 13;
    value: { value: { dataType: string; value: unknown } };
  }): Promise<unknown>;
  performMessageTransaction?(
    request: unknown,
    callback?: (error: unknown, response?: unknown) => void,
  ): unknown;
  _performMessageTransaction?(
    request: unknown,
    callback: (error: unknown, response?: unknown) => void,
  ): void;
}

export interface OpcUaReadDescription {
  nodeId: string;
  attributeId: number;
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
  certificateManager?: { automaticallyAcceptUnknownCertificate: unknown };
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
  NodeIdType: Record<string, number>;
  NodeId: new (type: number, value: number | string | Buffer, namespace: number) => unknown;
  WriteRequest: new (options: Record<string, unknown>) => unknown;
  OPCUACertificateManager: new (options: Record<string, unknown>) => {
    referenceCounter: number;
    dispose(): Promise<void>;
  };
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

export class NodeOpcUaGateway implements OpcUaGateway {
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
    this.clientFactory =
      options?.clientFactory ??
      ((clientOptions) => createNodeOpcUaClient(clientOptions, options?.certificateManager));
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
        let response: OpcUaBrowseResponse;
        try {
          response = await session.browse(buildBrowseDescription(currentNodeId));
        } catch (error) {
          throw new OpcUaStatusError(
            'OPC UA browse service failed.',
            serviceStatusFromError(error),
          );
        }
        const status = mapStatusCode(response.statusCode);
        if (!status || statusSeverity(status) !== 'good')
          throw new OpcUaStatusError('OPC UA browse failed.', status);
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

    let dataValue: OpcUaDataValueLike;
    try {
      dataValue = await session.read({ nodeId, attributeId: 13 });
    } catch (error) {
      throw new OpcUaStatusError('OPC UA read service failed.', serviceStatusFromError(error));
    }
    const status = mapStatusCode(dataValue.statusCode);
    if (!status || statusSeverity(status) === 'bad' || statusSeverity(status) === 'reserved') {
      throw new OpcUaStatusError('OPC UA read failed.', status);
    }
    return mapDataValue(nodeId, dataValue);
  }

  async readMany(nodeIds: string[]): Promise<ReadValueResult[]> {
    return Promise.all(nodeIds.map((nodeId) => this.read(nodeId)));
  }

  async writeNative(
    nodeId: NativeNodeId,
    dataType: NativeDataType,
    value: NativeScalar,
  ): Promise<NativeWriteResult> {
    const session = this.session;
    const transaction = session?._performMessageTransaction?.bind(session);
    if (typeof transaction !== 'function' || this.state !== 'connected') {
      throw new Error('Single-dispatch OPC UA session is unavailable.');
    }
    const parsedNodeId = parseNativeNodeId(nodeId.text);
    const scalar = validateNativeScalar(dataType, value);
    const sdk = loadNodeOpcUaModule();
    const type = sdk.NodeIdType[parsedNodeId.type];
    if (type === undefined) throw new Error('Unsupported OPC UA NodeId type.');
    const request = new sdk.WriteRequest({
      nodesToWrite: [
        {
          nodeId: new sdk.NodeId(type, parsedNodeId.value, parsedNodeId.namespace),
          attributeId: 13,
          value: { value: { dataType: scalar.dataType, value: scalar.value } },
        },
      ],
    });
    return new Promise((resolve, reject) => {
      transaction(request, (error, response) => {
        const serviceStatus = serviceStatusFromResponse(response) ?? serviceStatusFromError(error);
        if (serviceStatus && statusSeverity(serviceStatus) !== 'good') {
          resolve({ kind: 'service_error', statusCode: serviceStatus });
          return;
        }
        if (error && (!response || !serviceStatus)) {
          reject(error instanceof Error ? error : new Error('OPC UA write transaction failed.'));
          return;
        }
        if (!serviceStatus) {
          resolve({ kind: 'service_error' });
          return;
        }
        const results =
          typeof response === 'object' && response !== null && 'results' in response
            ? response.results
            : undefined;
        const statusCode =
          Array.isArray(results) && results.length === 1 ? mapStatusCode(results[0]) : undefined;
        resolve({ kind: 'operation', ...(statusCode ? { statusCode } : {}) });
      });
    });
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
      attributeStatusCodes: Object.fromEntries(
        Object.entries({
          browse,
          nodeId: nodeIdAttribute,
          dataType: dataTypeAttribute,
          valueRank: valueRankAttribute,
          userAccessLevel: userAccessLevelAttribute,
        }).flatMap(([key, result]) => {
          const status =
            result.status === 'fulfilled'
              ? mapStatusCode(result.value.statusCode)
              : serviceStatusFromError(result.reason);
          return status ? [[key, status]] : [];
        }),
      ),
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
      retainReadBrowseServiceResponses(this.session);
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

// The SDK's read/browse wrappers discard ordinary failed service responses.
function retainReadBrowseServiceResponses(session: OpcUaSessionLike): void {
  const transaction = session.performMessageTransaction?.bind(session);
  if (transaction === undefined) return;
  session.performMessageTransaction = (request, callback) => {
    if (callback === undefined) return transaction(request);
    return transaction(request, (error, response) => {
      const requestName =
        typeof request === 'object' && request !== null && 'constructor' in request
          ? request.constructor.name
          : undefined;
      if (
        error &&
        (requestName === 'ReadRequest' || requestName === 'BrowseRequest') &&
        serviceStatusFromResponse(response)
      ) {
        callback(Object.assign(new Error('OPC UA service failed.'), { response }), response);
      } else {
        callback(error, response);
      }
    });
  };
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
  const statusCode = mapStatusCode(dataValue.statusCode);
  const opcuaStatus = statusCode?.name;
  const sourceTimestamp = stringifyTimestamp(dataValue.sourceTimestamp);
  const serverTimestamp = stringifyTimestamp(dataValue.serverTimestamp);
  if (dataType !== undefined) result.dataType = dataType;
  if (opcuaStatus !== undefined) result.opcuaStatus = opcuaStatus;
  if (statusCode !== undefined) result.statusCode = statusCode;
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
  if (nodeOpcUaModule === undefined) {
    const loggers = require('node-opcua-debug') as {
      setDebugLogger(log: () => void): void;
      setWarningLogger(log: () => void): void;
      setErrorLogger(log: () => void): void;
      setTraceLogger(log: () => void): void;
    };
    loggers.setDebugLogger(() => process.stderr.write('OPC UA SDK debug diagnostic.\n'));
    loggers.setWarningLogger(() => process.stderr.write('OPC UA SDK warning diagnostic.\n'));
    loggers.setErrorLogger(() => process.stderr.write('OPC UA SDK error diagnostic.\n'));
    loggers.setTraceLogger(() => process.stderr.write('OPC UA SDK trace diagnostic.\n'));
    nodeOpcUaModule = require('node-opcua') as NodeOpcUaModule;
  }
  return nodeOpcUaModule;
}

function stringifyStatusCode(value: unknown): string | undefined {
  if (hasStatusName(value)) return value.name;
  return stringifyOpcUaValue(value);
}

function settledOpcUaStatus(
  result: PromiseSettledResult<{ statusCode?: unknown }>,
): string | undefined {
  if (result.status === 'rejected') return serviceStatusFromError(result.reason)?.name;
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
  const status = mapStatusCode(value);
  return status !== undefined && statusSeverity(status) === 'good';
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

function createNodeOpcUaClient(
  options: NodeOpcUaClientFactoryOptions,
  certificateManager?: { automaticallyAcceptUnknownCertificate: unknown },
): OpcUaClientLike {
  const nodeOpcUa = loadNodeOpcUaModule();
  const policy = nodeOpcUa.SecurityPolicy[options.securityPolicy];
  const mode = nodeOpcUa.MessageSecurityMode[options.securityMode];
  if (
    typeof policy !== 'string' ||
    policy === 'invalid' ||
    mode === undefined ||
    (options.securityMode === 'None') !== (options.securityPolicy === 'None')
  ) {
    throw new Error('Invalid OPC UA security mode or policy.');
  }
  if (certificateManager && certificateManager.automaticallyAcceptUnknownCertificate !== false) {
    throw new Error('OPC UA certificate manager must reject unknown certificates.');
  }
  const ownedManager = certificateManager
    ? undefined
    : new nodeOpcUa.OPCUACertificateManager({ automaticallyAcceptUnknownCertificate: false });
  let client: RealNodeOpcUaClient;
  try {
    client = nodeOpcUa.OPCUAClient.create({
      clientCertificateManager: certificateManager ?? ownedManager,
      applicationName: 'opcua-mcp-server',
      connectionStrategy: { maxRetry: 0 },
      endpointMustExist: false,
      securityMode: mode,
      securityPolicy: policy,
    });
  } catch (error) {
    if (ownedManager) {
      void (async () => {
        while (ownedManager.referenceCounter > 0) await ownedManager.dispose();
        await ownedManager.dispose();
      })().catch(() => undefined);
    }
    throw error;
  }

  let disconnectPromise: Promise<void> | undefined;
  return {
    connect: (endpointUrl) => client.connect(endpointUrl),
    disconnect: () =>
      (disconnectPromise ??= (async () => {
        try {
          await client.disconnect();
        } finally {
          if (ownedManager) {
            while (ownedManager.referenceCounter > 0) await ownedManager.dispose();
            await ownedManager.dispose();
          }
        }
      })()),
    createSession: async (userIdentity) => {
      const session = await client.createSession(
        userIdentity === undefined
          ? undefined
          : {
              type: nodeOpcUa.UserTokenType.UserName,
              userName: userIdentity.userName,
              password: userIdentity.password,
            },
      );
      if (typeof session.performMessageTransaction !== 'function') {
        await session.close();
        throw new Error('OPC UA service response seam is unavailable.');
      }
      return session;
    },
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
