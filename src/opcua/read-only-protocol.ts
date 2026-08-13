export type OpcUaProtocolErrorCode =
  | 'connection_changed'
  | 'opcua_access_denied'
  | 'opcua_operation_failed'
  | 'operation_cancelled'
  | 'operation_timeout';

export class OpcUaProtocolError extends Error {
  readonly code: OpcUaProtocolErrorCode;
  readonly statusCode: string | undefined;

  constructor(code: OpcUaProtocolErrorCode, message: string, statusCode?: string) {
    super(message);
    this.name = 'OpcUaProtocolError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ProtocolFailure {
  ok: false;
  error: {
    code: OpcUaProtocolErrorCode;
    message: string;
    statusCode?: string;
  };
}

export type ProtocolResult<T> = { ok: true; value: T } | ProtocolFailure;
export type ProtocolQuality = 'good' | 'uncertain' | 'bad';
export type NativeContinuationPoint = Uint8Array;

export interface ProtocolOperationContext {
  signal?: AbortSignal;
  /** Absolute Unix time in milliseconds. */
  deadlineAt?: number;
}

export interface ProtocolReadRequest {
  nodeId: string;
  attributeId: number;
  indexRange?: string;
}

export interface ProtocolDataValue {
  statusCode: string;
  quality: ProtocolQuality;
  value?: unknown;
  dataType?: string;
  sourceTimestamp?: string;
  serverTimestamp?: string;
}

export interface ProtocolQualifiedName {
  namespaceIndex: number;
  name: string;
}

export interface ProtocolLocalizedText {
  text: string;
  locale?: string;
}

export interface ProtocolReference {
  nodeId: string;
  referenceTypeId: string;
  isForward: boolean;
  browseName?: ProtocolQualifiedName;
  displayName?: ProtocolLocalizedText;
  nodeClass?: number;
  typeDefinition?: string;
}

export interface ProtocolBrowseRequest {
  nodeId: string;
  direction: 'forward' | 'inverse' | 'both';
  referenceTypeId: string;
  includeSubtypes: boolean;
  nodeClassMask: number;
  requestedMaxReferencesPerNode: number;
}

export interface ProtocolBrowsePage {
  statusCode: string;
  references: ProtocolReference[];
  continuationPoint?: NativeContinuationPoint;
}

export interface ProtocolOperationLimits {
  maxNodesPerRead?: number;
  maxNodesPerBrowse?: number;
}

export interface ReadOnlyOpcUaSessionLease {
  readonly connectionGeneration: number;
  browse(
    request: ProtocolBrowseRequest,
    context?: ProtocolOperationContext,
  ): Promise<ProtocolResult<ProtocolBrowsePage>>;
  browseNext(
    continuationPoint: NativeContinuationPoint,
    context?: ProtocolOperationContext,
  ): Promise<ProtocolResult<ProtocolBrowsePage>>;
  read(
    requests: ProtocolReadRequest[],
    context?: ProtocolOperationContext,
  ): Promise<ProtocolResult<ProtocolDataValue[]>>;
  readNamespaceArray(context?: ProtocolOperationContext): Promise<ProtocolResult<string[]>>;
  readOperationLimits(
    context?: ProtocolOperationContext,
  ): Promise<ProtocolResult<ProtocolOperationLimits>>;
  releaseContinuationPoints(
    continuationPoints: NativeContinuationPoint[],
    context?: ProtocolOperationContext,
  ): Promise<ProtocolResult<void>>;
  assertGeneration(): void;
  release(): void;
}

export interface ReadOnlyOpcUaProtocolAdapter {
  acquireSession(context?: ProtocolOperationContext): Promise<ReadOnlyOpcUaSessionLease>;
}

export interface NodeOpcUaReadDescription {
  nodeId: string;
  attributeId: number;
  indexRange?: string;
}

export interface NodeOpcUaDataValue {
  value?: { dataType?: unknown; value?: unknown } | null;
  statusCode?: unknown;
  sourceTimestamp?: Date | string | null;
  serverTimestamp?: Date | string | null;
}

export interface NodeOpcUaBrowseDescription {
  nodeId: string;
  browseDirection: 'Forward' | 'Inverse' | 'Both';
  referenceTypeId: string;
  includeSubtypes: boolean;
  nodeClassMask: number;
  requestedMaxReferencesPerNode: number;
  resultMask: number;
}

export interface NodeOpcUaReference {
  nodeId?: unknown;
  referenceTypeId?: unknown;
  isForward?: boolean;
  browseName?: unknown;
  displayName?: { locale?: string; text?: string } | string | null;
  nodeClass?: number;
  typeDefinition?: unknown;
}

export interface NodeOpcUaBrowseResult {
  statusCode?: unknown;
  references?: NodeOpcUaReference[] | null;
  continuationPoint?: unknown;
}

export interface NodeOpcUaReadOnlySession {
  browse(description: NodeOpcUaBrowseDescription): Promise<NodeOpcUaBrowseResult>;
  browseNext(
    continuationPoints: NativeContinuationPoint[],
    releaseContinuationPoints: boolean,
  ): Promise<NodeOpcUaBrowseResult | NodeOpcUaBrowseResult[]>;
  readBatch(descriptions: NodeOpcUaReadDescription[]): Promise<NodeOpcUaDataValue[]>;
}

export interface NodeOpcUaSessionSnapshot {
  session: NodeOpcUaReadOnlySession;
  connectionGeneration: number;
}

export interface NodeOpcUaReadOnlySessionSource {
  currentGeneration(): number;
  sessionSnapshot(): NodeOpcUaSessionSnapshot | undefined;
}

const ATTRIBUTE_VALUE = 13;
const NODE_NAMESPACE_ARRAY = 'i=2255';
const NODE_MAX_NODES_PER_READ = 'i=11705';
const NODE_MAX_NODES_PER_BROWSE = 'i=11710';
const BROWSE_RESULT_MASK_ALL = 63;

export class NodeOpcUaReadOnlyAdapter implements ReadOnlyOpcUaProtocolAdapter {
  constructor(private readonly source: NodeOpcUaReadOnlySessionSource) {}

  acquireSession(context: ProtocolOperationContext = {}): Promise<ReadOnlyOpcUaSessionLease> {
    assertContextActive(context);
    const snapshot = this.source.sessionSnapshot();
    if (snapshot === undefined) {
      throw new OpcUaProtocolError(
        'opcua_operation_failed',
        'The OPC UA session is not connected.',
      );
    }
    return Promise.resolve(new NodeOpcUaSessionLease(this.source, snapshot));
  }
}

class NodeOpcUaSessionLease implements ReadOnlyOpcUaSessionLease {
  readonly connectionGeneration: number;
  private released = false;

  constructor(
    private readonly source: NodeOpcUaReadOnlySessionSource,
    private readonly snapshot: NodeOpcUaSessionSnapshot,
  ) {
    this.connectionGeneration = snapshot.connectionGeneration;
  }

  async browse(
    request: ProtocolBrowseRequest,
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<ProtocolBrowsePage>> {
    this.assertGeneration();
    assertContextActive(context);
    const native = startNative(() =>
      this.snapshot.session.browse({
        nodeId: request.nodeId,
        browseDirection: mapBrowseDirection(request.direction),
        referenceTypeId: request.referenceTypeId,
        includeSubtypes: request.includeSubtypes,
        nodeClassMask: request.nodeClassMask,
        requestedMaxReferencesPerNode: request.requestedMaxReferencesPerNode,
        resultMask: BROWSE_RESULT_MASK_ALL,
      }),
    );
    const response = await this.awaitNative(native, context, (lateResponse) =>
      this.releaseLateContinuation(lateResponse),
    );
    this.assertOrRelease(response);
    const result = mapBrowseResult(response);
    if (!result.ok) this.releaseLateContinuation(response);
    return result;
  }

  async browseNext(
    continuationPoint: NativeContinuationPoint,
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<ProtocolBrowsePage>> {
    this.assertGeneration();
    assertContextActive(context);
    const native = startNative(() => this.snapshot.session.browseNext([continuationPoint], false));
    const releaseLateBrowseNext = (
      lateResponse?: NodeOpcUaBrowseResult | NodeOpcUaBrowseResult[],
    ): void => {
      void this.releaseNativeContinuationPoints([
        continuationPoint,
        ...(lateResponse === undefined ? [] : continuationPointsFromResponse(lateResponse)),
      ]);
    };
    let response: NodeOpcUaBrowseResult | NodeOpcUaBrowseResult[];
    try {
      response = await this.awaitNative(native, context, releaseLateBrowseNext, () =>
        releaseLateBrowseNext(),
      );
    } catch (error) {
      releaseLateBrowseNext();
      throw error;
    }
    const first = Array.isArray(response) ? response[0] : response;
    if (first === undefined) {
      releaseLateBrowseNext();
      return protocolFailure('BadUnexpectedError');
    }
    this.assertOrRelease(first, [continuationPoint]);
    const result = mapBrowseResult(first);
    if (!result.ok) {
      void this.releaseNativeContinuationPoints([
        continuationPoint,
        ...continuationPointsFromResponse(first),
      ]);
    }
    return result;
  }

  async read(
    requests: ProtocolReadRequest[],
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<ProtocolDataValue[]>> {
    this.assertGeneration();
    assertContextActive(context);
    const native = startNative(() =>
      this.snapshot.session.readBatch(
        requests.map((request) => {
          const description: NodeOpcUaReadDescription = {
            nodeId: request.nodeId,
            attributeId: request.attributeId,
          };
          if (request.indexRange !== undefined) description.indexRange = request.indexRange;
          return description;
        }),
      ),
    );
    const values = await this.awaitNative(native, context);
    this.assertGeneration();
    if (values.length !== requests.length) return protocolFailure('BadUnexpectedError');
    return { ok: true, value: values.map(mapDataValue) };
  }

  async readNamespaceArray(
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<string[]>> {
    const result = await this.read(
      [{ nodeId: NODE_NAMESPACE_ARRAY, attributeId: ATTRIBUTE_VALUE }],
      context,
    );
    if (!result.ok) return result;
    const value = result.value[0];
    if (
      value === undefined ||
      value.quality === 'bad' ||
      !Array.isArray(value.value) ||
      !value.value.every((entry) => typeof entry === 'string')
    ) {
      return protocolFailure(value?.statusCode ?? 'BadTypeMismatch');
    }
    return { ok: true, value: value.value };
  }

  async readOperationLimits(
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<ProtocolOperationLimits>> {
    const result = await this.read(
      [
        { nodeId: NODE_MAX_NODES_PER_READ, attributeId: ATTRIBUTE_VALUE },
        { nodeId: NODE_MAX_NODES_PER_BROWSE, attributeId: ATTRIBUTE_VALUE },
      ],
      context,
    );
    if (!result.ok) return result;
    const limits: ProtocolOperationLimits = {};
    const maxNodesPerRead = positiveInteger(result.value[0]);
    const maxNodesPerBrowse = positiveInteger(result.value[1]);
    if (maxNodesPerRead !== undefined) limits.maxNodesPerRead = maxNodesPerRead;
    if (maxNodesPerBrowse !== undefined) limits.maxNodesPerBrowse = maxNodesPerBrowse;
    return { ok: true, value: limits };
  }

  async releaseContinuationPoints(
    continuationPoints: NativeContinuationPoint[],
    context: ProtocolOperationContext = {},
  ): Promise<ProtocolResult<void>> {
    this.assertGeneration();
    assertContextActive(context);
    if (continuationPoints.length === 0) return { ok: true, value: undefined };
    const response = await this.awaitNative(
      startNative(() => this.snapshot.session.browseNext(continuationPoints, true)),
      context,
    );
    this.assertGeneration();
    const responses = Array.isArray(response) ? response : [response];
    const failed = responses.find(
      (entry) => classifyStatus(stringifyStatus(entry.statusCode)) === 'bad',
    );
    if (failed !== undefined) return protocolFailure(stringifyStatus(failed.statusCode));
    return { ok: true, value: undefined };
  }

  assertGeneration(): void {
    if (this.released) {
      throw new OpcUaProtocolError('opcua_operation_failed', 'The OPC UA session lease is closed.');
    }
    if (this.source.currentGeneration() !== this.connectionGeneration) {
      throw new OpcUaProtocolError(
        'connection_changed',
        'The OPC UA connection changed during the operation.',
      );
    }
  }

  release(): void {
    this.released = true;
  }

  private async awaitNative<T>(
    native: Promise<T>,
    context: ProtocolOperationContext,
    onLateResult?: (result: T) => void,
    onLateFailure?: () => void,
  ): Promise<T> {
    try {
      return await awaitNativeOperation(native, context, onLateResult, onLateFailure);
    } catch (error) {
      if (error instanceof OpcUaProtocolError && error.code === 'opcua_operation_failed') {
        this.assertGeneration();
      }
      throw error;
    }
  }

  private assertOrRelease(
    response: NodeOpcUaBrowseResult,
    additionalContinuationPoints: NativeContinuationPoint[] = [],
  ): void {
    try {
      this.assertGeneration();
    } catch (error) {
      void this.releaseNativeContinuationPoints([
        ...additionalContinuationPoints,
        ...continuationPointsFromResponse(response),
      ]);
      throw error;
    }
  }

  private releaseLateContinuation(response: NodeOpcUaBrowseResult | NodeOpcUaBrowseResult[]): void {
    void this.releaseNativeContinuationPoints(continuationPointsFromResponse(response));
  }

  private async releaseNativeContinuationPoints(
    continuationPoints: NativeContinuationPoint[],
  ): Promise<void> {
    if (continuationPoints.length === 0) return;
    try {
      await this.snapshot.session.browseNext(
        deduplicateContinuationPoints(continuationPoints),
        true,
      );
    } catch {
      // Best effort: cancellation and generation changes must not surface late SDK failures.
    }
  }
}

export async function runGenerationFenced<T>(
  adapter: ReadOnlyOpcUaProtocolAdapter,
  operation: (lease: ReadOnlyOpcUaSessionLease) => Promise<T>,
  context: ProtocolOperationContext = {},
): Promise<T> {
  const lease = await adapter.acquireSession(context);
  try {
    const result = await operation(lease);
    lease.assertGeneration();
    return result;
  } finally {
    lease.release();
  }
}

export class GenerationScopedCache<K, V> {
  private generation: number | undefined;
  private readonly entries = new Map<K, V>();
  private readonly loads = new Map<K, Promise<V | undefined>>();

  get(generation: number, key: K): V | undefined {
    if (this.generation !== generation) return undefined;
    return this.entries.get(key);
  }

  set(generation: number, key: K, value: V): void {
    this.activate(generation);
    if (generation === this.generation) this.entries.set(key, value);
  }

  getOrLoad(
    generation: number,
    key: K,
    isCurrent: () => boolean,
    loader: () => Promise<V>,
  ): Promise<V | undefined> {
    this.activate(generation);
    if (generation !== this.generation || !isCurrent()) return Promise.resolve(undefined);
    const cached = this.entries.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const activeLoad = this.loads.get(key);
    if (activeLoad !== undefined) return activeLoad;

    const load = loader()
      .then((value) => {
        if (generation !== this.generation || !isCurrent()) return undefined;
        this.entries.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.loads.get(key) === load) this.loads.delete(key);
      });
    this.loads.set(key, load);
    return load;
  }

  clear(): void {
    this.generation = undefined;
    this.entries.clear();
    this.loads.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private activate(generation: number): void {
    if (this.generation === undefined || generation > this.generation) {
      this.generation = generation;
      this.entries.clear();
      this.loads.clear();
    }
  }
}

function assertContextActive(context: ProtocolOperationContext): void {
  if (context.signal?.aborted === true) {
    throw new OpcUaProtocolError('operation_cancelled', 'The OPC UA operation was cancelled.');
  }
  if (context.deadlineAt !== undefined && context.deadlineAt <= Date.now()) {
    throw new OpcUaProtocolError('operation_timeout', 'The OPC UA operation timed out.');
  }
}

function startNative<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch {
    return Promise.reject(
      new OpcUaProtocolError('opcua_operation_failed', 'The OPC UA operation failed.'),
    );
  }
}

function awaitNativeOperation<T>(
  native: Promise<T>,
  context: ProtocolOperationContext,
  onLateResult?: (result: T) => void,
  onLateFailure?: () => void,
): Promise<T> {
  assertContextActive(context);
  return new Promise<T>((resolve, reject) => {
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (terminal) return;
      terminal = true;
      if (timer !== undefined) clearTimeout(timer);
      context.signal?.removeEventListener('abort', cancel);
      callback();
    };
    const cancel = (): void => {
      finish(() =>
        reject(
          new OpcUaProtocolError('operation_cancelled', 'The OPC UA operation was cancelled.'),
        ),
      );
    };

    context.signal?.addEventListener('abort', cancel, { once: true });
    if (context.deadlineAt !== undefined) {
      timer = setTimeout(
        () => {
          finish(() =>
            reject(new OpcUaProtocolError('operation_timeout', 'The OPC UA operation timed out.')),
          );
        },
        Math.max(0, context.deadlineAt - Date.now()),
      );
    }

    void native.then(
      (result) => {
        if (terminal) {
          onLateResult?.(result);
          return;
        }
        finish(() => resolve(result));
      },
      () => {
        if (terminal) {
          onLateFailure?.();
          return;
        }
        finish(() =>
          reject(new OpcUaProtocolError('opcua_operation_failed', 'The OPC UA operation failed.')),
        );
      },
    );
  });
}

function mapBrowseDirection(
  direction: ProtocolBrowseRequest['direction'],
): NodeOpcUaBrowseDescription['browseDirection'] {
  if (direction === 'forward') return 'Forward';
  if (direction === 'inverse') return 'Inverse';
  return 'Both';
}

function mapBrowseResult(response: NodeOpcUaBrowseResult): ProtocolResult<ProtocolBrowsePage> {
  const statusCode = stringifyStatus(response.statusCode);
  if (classifyStatus(statusCode) === 'bad') return protocolFailure(statusCode);
  const page: ProtocolBrowsePage = {
    statusCode,
    references: (response.references ?? []).flatMap((reference) => {
      const nodeId = stringifyValue(reference.nodeId);
      const referenceTypeId = stringifyValue(reference.referenceTypeId);
      if (nodeId === undefined || referenceTypeId === undefined) return [];
      const mapped: ProtocolReference = {
        nodeId,
        referenceTypeId,
        isForward: reference.isForward !== false,
      };
      const browseName = mapQualifiedName(reference.browseName);
      const displayName = mapLocalizedText(reference.displayName);
      const typeDefinition = stringifyValue(reference.typeDefinition);
      if (browseName !== undefined) mapped.browseName = browseName;
      if (displayName !== undefined) mapped.displayName = displayName;
      if (typeof reference.nodeClass === 'number') mapped.nodeClass = reference.nodeClass;
      if (typeDefinition !== undefined) mapped.typeDefinition = typeDefinition;
      return [mapped];
    }),
  };
  const continuationPoint = asContinuationPoint(response.continuationPoint);
  if (continuationPoint !== undefined) page.continuationPoint = continuationPoint;
  return { ok: true, value: page };
}

function mapDataValue(dataValue: NodeOpcUaDataValue): ProtocolDataValue {
  const statusCode = stringifyStatus(dataValue.statusCode);
  const result: ProtocolDataValue = { statusCode, quality: classifyStatus(statusCode) };
  if (dataValue.value !== undefined && dataValue.value !== null) {
    result.value = dataValue.value.value;
    const dataType = stringifyValue(dataValue.value.dataType);
    if (dataType !== undefined) result.dataType = dataType;
  }
  const sourceTimestamp = stringifyTimestamp(dataValue.sourceTimestamp);
  const serverTimestamp = stringifyTimestamp(dataValue.serverTimestamp);
  if (sourceTimestamp !== undefined) result.sourceTimestamp = sourceTimestamp;
  if (serverTimestamp !== undefined) result.serverTimestamp = serverTimestamp;
  return result;
}

function protocolFailure(statusCode: string): ProtocolFailure {
  const denied = statusCode.includes('AccessDenied') || statusCode.includes('UserAccessDenied');
  const error: ProtocolFailure['error'] = {
    code: denied ? 'opcua_access_denied' : 'opcua_operation_failed',
    message: denied ? 'The OPC UA Server denied the operation.' : 'The OPC UA operation failed.',
  };
  if (statusCode !== 'Unknown') error.statusCode = statusCode;
  return { ok: false, error };
}

function classifyStatus(statusCode: string): ProtocolQuality {
  if (statusCode.startsWith('Good')) return 'good';
  if (statusCode.startsWith('Uncertain')) return 'uncertain';
  return 'bad';
}

function stringifyStatus(value: unknown): string {
  if (typeof value === 'object' && value !== null && hasStringProperty(value, 'name')) {
    return value.name;
  }
  return stringifyValue(value) ?? 'Unknown';
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function' &&
    value.toString !== Object.prototype.toString
  ) {
    // node-opcua identifiers expose their canonical form through a custom toString.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return value.toString();
  }
  return undefined;
}

function stringifyTimestamp(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : undefined;
}

function mapQualifiedName(
  value: NodeOpcUaReference['browseName'],
): ProtocolQualifiedName | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!hasNumberProperty(value, 'namespaceIndex') || !hasStringProperty(value, 'name')) {
    return undefined;
  }
  return { namespaceIndex: value.namespaceIndex, name: value.name };
}

function mapLocalizedText(
  value: NodeOpcUaReference['displayName'],
): ProtocolLocalizedText | undefined {
  if (typeof value === 'string') return { text: value };
  if (typeof value !== 'object' || value === null || !hasStringProperty(value, 'text')) {
    return undefined;
  }
  const mapped: ProtocolLocalizedText = { text: value.text };
  if (hasStringProperty(value, 'locale')) mapped.locale = value.locale;
  return mapped;
}

function asContinuationPoint(value: unknown): NativeContinuationPoint | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return undefined;
  return Uint8Array.from(value);
}

function continuationPointsFromResponse(
  response: NodeOpcUaBrowseResult | NodeOpcUaBrowseResult[],
): NativeContinuationPoint[] {
  const responses = Array.isArray(response) ? response : [response];
  return responses.flatMap((entry) => {
    const point = asContinuationPoint(entry.continuationPoint);
    return point === undefined ? [] : [point];
  });
}

function deduplicateContinuationPoints(
  points: NativeContinuationPoint[],
): NativeContinuationPoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = Buffer.from(point).toString('base64');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function positiveInteger(value: ProtocolDataValue | undefined): number | undefined {
  const candidate = value?.value;
  return value?.quality !== 'bad' && Number.isSafeInteger(candidate) && Number(candidate) > 0
    ? Number(candidate)
    : undefined;
}

function hasStringProperty<K extends string>(value: object, key: K): value is Record<K, string> {
  return key in value && typeof (value as Record<K, unknown>)[key] === 'string';
}

function hasNumberProperty<K extends string>(value: object, key: K): value is Record<K, number> {
  return key in value && typeof (value as Record<K, unknown>)[key] === 'number';
}
