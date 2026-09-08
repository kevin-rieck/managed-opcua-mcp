import { randomUUID } from 'node:crypto';
import type {
  BrowseEdge,
  BrowsePathEdge,
  BrowseRequest,
  BrowseResult,
  FieldOutcome,
  InspectEntry,
  InspectFields,
  InspectRequest,
  InspectResult,
  InspectionError,
  ItemState,
  LocalizedTextValue,
  ModelContextResult,
  ModelContextSuccess,
  BrowseSuccess,
  InspectSuccess,
  ReadSuccess,
  NamespaceContext,
  NamespaceModelMetadata,
  NodeClass,
  NodeSelector,
  OpcUaInspectionModule,
  OpcUaJsonScalar,
  OpcUaJsonValue,
  QualifiedNameIdentity,
  QualifiedNodeIdentity,
  ReadRequest,
  ReadEntry,
  ReadResult,
  ReadValueEntry,
  ResolvedNodeIdentity,
  AccessLevelValue,
  EngineeringUnitValue,
  EnumValue,
} from './inspection-contracts.js';
import {
  GenerationScopedCache,
  OpcUaProtocolError,
  type ProtocolBrowsePage,
  type ProtocolBrowseRequest,
  type ProtocolDataValue,
  type ProtocolFailure,
  type ProtocolLocalizedText,
  type ProtocolOperationContext,
  type ProtocolQualifiedName,
  type ProtocolReadRequest,
  type ProtocolReference,
  type ProtocolResult,
  type ReadOnlyOpcUaProtocolAdapter,
  type ReadOnlyOpcUaSessionLease,
} from './read-only-protocol.js';
import { parseCanonicalNodeId, validateNodeSelectorBatch } from './selector-validation.js';
import {
  WELL_KNOWN_OPC_UA_DATA_TYPES,
  WELL_KNOWN_OPC_UA_NODE_CLASSES,
} from './well-known-enums.js';

const ATTRIBUTE_NODE_ID = 1;
const ATTRIBUTE_NODE_CLASS = 2;
const ATTRIBUTE_BROWSE_NAME = 3;
const ATTRIBUTE_DISPLAY_NAME = 4;
const ATTRIBUTE_DESCRIPTION = 5;
const ATTRIBUTE_VALUE = 13;
const ATTRIBUTE_DATA_TYPE = 14;
const ATTRIBUTE_VALUE_RANK = 15;
const ATTRIBUTE_ACCESS_LEVEL = 17;
const ATTRIBUTE_USER_ACCESS_LEVEL = 18;
const ATTRIBUTE_EXECUTABLE = 21;
const ATTRIBUTE_USER_EXECUTABLE = 22;
const SERVER_NAMESPACES = 'ns=0;i=11715';
const REFERENCES = 'ns=0;i=31';
const HIERARCHICAL_REFERENCES = 'ns=0;i=33';
const HAS_COMPONENT = 'ns=0;i=47';
const HAS_PROPERTY = 'ns=0;i=46';
const HAS_TYPE_DEFINITION = 'ns=0;i=40';
const DEFAULT_INSPECTION_BATCH_SIZE = 25;
const DEFAULT_READ_BATCH_SIZE = 50;
const DEFAULT_BROWSE_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const HARD_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const STANDARD_NAMESPACE_URI = 'http://opcfoundation.org/UA/';

let standardNames: Map<number, string> | undefined;

export interface OpcUaInspectionModuleOptions {
  /** Only configured Read Entry Points may be resolved when this is supplied. */
  resolveLabel?: (label: string) => string | undefined;
  maximumInspectionBatchSize?: number;
  maximumReadBatchSize?: number;
  defaultBrowseDepth?: number;
  maximumBrowseDepth?: number;
  maximumBrowsePageSize?: number;
  maximumResponseBytes?: number;
  maximumArrayElements?: number;
  maximumBrowseEdges?: number;
  maximumScannedReferences?: number;
  maximumExpandedNodes?: number;
  maximumBrowseServiceCalls?: number;
  cursorTtlMs?: number;
  maximumActiveCursors?: number;
  maximumConcurrentOperations?: number;
  operationDeadlineMs?: number;
  now?: () => Date;
}

/**
 * Read-only inspection implementation over the protocol adapter seam.
 *
 * It deliberately owns no connection and no long-lived model state. The only
 * values retained between operations are namespace mappings and namespace-zero
 * names, both fenced by the protocol connection generation.
 */
export class OpcUaInspectionService implements OpcUaInspectionModule {
  private readonly options: {
    resolveLabel?: (label: string) => string | undefined;
    now?: () => Date;
    maximumInspectionBatchSize: number;
    maximumReadBatchSize: number;
    defaultBrowseDepth: number;
    maximumBrowseDepth: number;
    maximumBrowsePageSize: number;
    maximumResponseBytes: number;
    maximumArrayElements: number;
    maximumBrowseEdges: number;
    maximumScannedReferences: number;
    maximumExpandedNodes: number;
    maximumBrowseServiceCalls: number;
    cursorTtlMs: number;
    maximumActiveCursors: number;
    maximumConcurrentOperations: number;
    operationDeadlineMs: number;
  };
  private readonly cursors = new Map<string, BrowseCursor>();
  private activeOperations = 0;
  private readonly readChunkSizes = new GenerationScopedCache<number, number>();
  private readonly namespaceCache = new GenerationScopedCache<number, string[]>();
  private readonly namespaceZeroNameCache = new GenerationScopedCache<string, string>();

  constructor(
    private readonly adapter: ReadOnlyOpcUaProtocolAdapter,
    options: OpcUaInspectionModuleOptions = {},
  ) {
    const resolvedOptions: OpcUaInspectionModuleOptions = {};
    if (options.resolveLabel !== undefined) resolvedOptions.resolveLabel = options.resolveLabel;
    if (options.now !== undefined) resolvedOptions.now = options.now;
    this.options = {
      ...resolvedOptions,
      maximumInspectionBatchSize: boundedPositive(
        options.maximumInspectionBatchSize,
        DEFAULT_INSPECTION_BATCH_SIZE,
        100,
      ),
      maximumReadBatchSize: boundedPositive(
        options.maximumReadBatchSize,
        DEFAULT_READ_BATCH_SIZE,
        500,
      ),
      defaultBrowseDepth: boundedNonNegative(options.defaultBrowseDepth, 1, 10),
      maximumBrowseDepth: boundedNonNegative(options.maximumBrowseDepth, 10, 10),
      maximumBrowsePageSize: boundedPositive(
        options.maximumBrowsePageSize,
        DEFAULT_MAX_PAGE_SIZE,
        DEFAULT_MAX_PAGE_SIZE,
      ),
      maximumResponseBytes: boundedPositive(
        options.maximumResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        HARD_MAX_RESPONSE_BYTES,
      ),
      maximumArrayElements: boundedPositive(options.maximumArrayElements, 1_000, 10_000),
      maximumBrowseEdges: boundedPositive(options.maximumBrowseEdges, 2_000, 10_000),
      maximumScannedReferences: boundedPositive(options.maximumScannedReferences, 10_000, 50_000),
      maximumExpandedNodes: boundedPositive(options.maximumExpandedNodes, 2_000, 10_000),
      maximumBrowseServiceCalls: boundedPositive(options.maximumBrowseServiceCalls, 1_000, 5_000),
      cursorTtlMs: boundedPositive(options.cursorTtlMs, 120_000, 900_000),
      maximumActiveCursors: boundedPositive(options.maximumActiveCursors, 100, 1_000),
      maximumConcurrentOperations: boundedPositive(options.maximumConcurrentOperations, 16, 100),
      operationDeadlineMs: boundedPositive(options.operationDeadlineMs, 30_000, 120_000),
    };
  }

  async browse(request: BrowseRequest, signal?: AbortSignal): Promise<BrowseResult> {
    if (!this.acquireOperation()) return failure('server_busy', 'The inspection server is busy.');
    const context = this.context(signal);
    try {
      if ('continuation' in request)
        return await this.continueBrowse(request.continuation, context);

      const validation = validateNodeSelectorBatch([request.selector], {
        maximumBatchSize: 1,
        parseNodeId: parseCanonicalNodeId,
        ...(this.options.resolveLabel === undefined
          ? {}
          : { resolveLabel: this.options.resolveLabel }),
      });
      if (!validation.ok) return validation;
      const item = validation.items[0];
      if (item === undefined) return failure('invalid_selector', 'The selector is invalid.');
      const selectorValidation = item.validation;
      if (!selectorValidation.ok) return failure('invalid_selector', selectorValidation.error.message);

      return await this.withLease(context, async (lease) => {
        await this.cleanupExpiredCursors(lease, context);
        const table = await this.loadNamespaceTable(lease, context);
        const pageSize = clampInteger(
          request.pageSize ?? DEFAULT_BROWSE_PAGE_SIZE,
          1,
          this.options.maximumBrowsePageSize,
        );
        const limits = await lease.readOperationLimits(context);
        const nativePageSize =
          limits.ok && limits.value.maxNodesPerBrowse !== undefined
            ? Math.max(1, Math.min(pageSize, limits.value.maxNodesPerBrowse))
            : pageSize;
        const selector = selectorValidation.canonicalNodeId;
        const state: BrowseCursorState = {
          generation: lease.connectionGeneration,
          start: this.qualifyNodeId(selector, table),
          selector,
          direction: request.direction ?? 'forward',
          referenceTypeId:
            (request.referenceScope ?? 'hierarchical') === 'hierarchical'
              ? HIERARCHICAL_REFERENCES
              : REFERENCES,
          nodeClassMask: nodeClassMaskFor(request.targetNodeClasses),
          depth: clampInteger(
            request.depth ?? this.options.defaultBrowseDepth,
            0,
            this.options.maximumBrowseDepth,
          ),
          pageSize,
          nativePageSize,
          ...(request.targetNodeClasses === undefined
            ? {}
            : { targetNodeClasses: request.targetNodeClasses }),
          frontier: [
            { nodeId: selector, identity: this.qualifyNodeId(selector, table), depth: 0, path: [] },
          ],
          seen: new Set([selector]),
          edgesReturned: 0,
          scannedReferences: 0,
          expandedNodes: 0,
          serviceCalls: 0,
        };
        try {
          return await this.advanceBrowse(lease, state, table, context);
        } catch (error) {
          await this.releaseCursorState(lease, state, context);
          throw error;
        }
      });
    } catch (error) {
      return failureFrom(error);
    } finally {
      this.releaseOperation();
    }
  }

  private async continueBrowse(
    token: string,
    context: ProtocolOperationContext,
  ): Promise<BrowseResult> {
    return this.withLease(context, async (lease) => {
      await this.cleanupExpiredCursors(lease, context);
      const cursor = this.cursors.get(token);
      if (cursor?.generation !== lease.connectionGeneration) {
        if (cursor !== undefined) this.cursors.delete(token);
        return failure('invalid_continuation', 'The browse continuation is invalid.');
      }
      cursor.expiresAt = Date.now() + this.options.cursorTtlMs;
      if (cursor.response !== undefined) return cursor.response;
      const cursorState = cursor.state;
      if (cursorState === undefined) {
        this.cursors.delete(token);
        return failure('invalid_continuation', 'The browse continuation is invalid.');
      }
      if (cursor.pending !== undefined) return cursor.pending;
      const operation = (async (): Promise<BrowseResult> => {
        try {
          const table = await this.loadNamespaceTable(lease, context);
          const response = await this.advanceBrowse(lease, cursorState, table, context, token);
          if (!response.ok) {
            this.cursors.delete(token);
            await this.releaseCursorState(lease, cursorState, context);
            return response;
          }
          delete cursor.state;
          cursor.response = response;
          return response;
        } catch (error) {
          this.cursors.delete(token);
          await this.releaseCursorState(lease, cursorState, context);
          throw error;
        }
      })();
      cursor.pending = operation;
      return operation;
    });
  }

  private async advanceBrowse(
    lease: ReadOnlyOpcUaSessionLease,
    state: BrowseCursorState,
    table: NamespaceTable,
    context: ProtocolOperationContext,
    replayToken?: string,
  ): Promise<BrowseResult> {
    const observedAt = this.observedAt();
    const edges: BrowseEdge[] = [];
    const incompleteReasons: string[] = [];
    if (
      serializedBytes(
        this.browseResponse(state.start, state.generation, [], observedAt, true, [], undefined),
      ) > this.options.maximumResponseBytes
    )
      return failure('response_limit_exceeded', 'The browse response exceeds the configured size limit.');

    while (edges.length < state.pageSize) {
      let current = state.current;
      if (current === undefined) {
        const workItem = state.frontier.shift();
        if (workItem === undefined) break;
        if (workItem.depth >= state.depth) continue;
        if (state.expandedNodes >= this.options.maximumExpandedNodes) {
          incompleteReasons.push('resource_limit');
          break;
        }
        state.expandedNodes += 1;
        if (state.serviceCalls >= this.options.maximumBrowseServiceCalls) {
          incompleteReasons.push('resource_limit');
          break;
        }
        state.serviceCalls += 1;
        state.current = { item: workItem, references: [], index: 0 };
        current = state.current;
        const page = await lease.browse(
          {
            nodeId: workItem.nodeId,
            direction: state.direction,
            referenceTypeId: state.referenceTypeId,
            includeSubtypes: true,
            nodeClassMask: state.nodeClassMask,
            requestedMaxReferencesPerNode: state.nativePageSize,
          },
          context,
        );
        if (!page.ok) {
          incompleteReasons.push(page.error.code);
          delete state.current;
          continue;
        }
        current.references = page.value.references;
        if (page.value.continuationPoint === undefined) delete current.continuationPoint;
        else current.continuationPoint = page.value.continuationPoint;
      }

      if (current.index < current.references.length) {
        if (state.scannedReferences >= this.options.maximumScannedReferences) {
          incompleteReasons.push('resource_limit');
          break;
        }
        const reference = current.references[current.index];
        if (reference === undefined) continue;
        current.index += 1;
        state.scannedReferences += 1;
        const targetNodeId = canonicalizeBestEffort(reference.nodeId);
        const referenceTypeNodeId = canonicalizeBestEffort(reference.referenceTypeId);
        if (targetNodeId === undefined || referenceTypeNodeId === undefined) continue;
        const actualDirection = reference.isForward ? 'forward' : 'inverse';
        const targetClass = mapNodeClass(reference.nodeClass);
        if (
          state.targetNodeClasses !== undefined &&
          (targetClass.state !== 'present' || !state.targetNodeClasses.includes(targetClass.value))
        ) {
          continue;
        }
        const targetPreviouslySeen = state.seen.has(targetNodeId);
        const pathEdge: BrowsePathEdge = {
          sourceNodeId: current.item.nodeId,
          targetNodeId,
          referenceTypeNodeId,
          direction: actualDirection,
        };
        const path = [...current.item.path, pathEdge];
        const cycle =
          current.item.path.some((entry) => entry.sourceNodeId === targetNodeId) ||
          targetNodeId === state.selector;
        const targetIdentity = this.qualifyNodeId(targetNodeId, table);
        const qualifiedReference = await this.resolveNodeIdentity(
          lease,
          referenceTypeNodeId,
          table,
          context,
        );
        const edge: BrowseEdge = {
          source: current.item.identity,
          target: targetIdentity,
          referenceType: qualifiedReference,
          direction: actualDirection,
          targetBrowseName:
            reference.browseName === undefined
              ? fieldFailed(
                  'browse_name_unavailable',
                  'The Browse response did not include a BrowseName.',
                )
              : fieldPresent(this.qualifyName(reference.browseName, table)),
          targetDisplayName:
            reference.displayName === undefined
              ? fieldFailed(
                  'display_name_unavailable',
                  'The Browse response did not include a DisplayName.',
                )
              : referenceDisplayOutcome(reference.displayName),
          targetNodeClass: targetClass,
          depth: current.item.depth + 1,
          path,
          targetPreviouslySeen,
          cycle,
        };
        const candidate = this.browseResponse(
          state.start,
          state.generation,
          [...edges, edge],
          observedAt,
          false,
          [],
          undefined,
        );
        if (serializedBytes(candidate) > this.options.maximumResponseBytes) {
          current.index -= 1;
          if (edges.length === 0)
            return failure('response_limit_exceeded', 'The browse response exceeds the configured size limit.');
          incompleteReasons.push('response_size');
          break;
        }
        edges.push(edge);
        state.edgesReturned += 1;
        if (!targetPreviouslySeen) state.seen.add(targetNodeId);
        if (!targetPreviouslySeen && !cycle && current.item.depth + 1 < state.depth) {
          state.frontier.push({
            nodeId: targetNodeId,
            identity: targetIdentity,
            depth: current.item.depth + 1,
            path,
          });
        }
        if (state.edgesReturned >= this.options.maximumBrowseEdges) {
          incompleteReasons.push('resource_limit');
          break;
        }
        continue;
      }

      const continuationPoint = current.continuationPoint;
      if (continuationPoint !== undefined) {
        if (state.serviceCalls >= this.options.maximumBrowseServiceCalls) {
          incompleteReasons.push('resource_limit');
          break;
        }
        state.serviceCalls += 1;
        const next = await lease.browseNext(continuationPoint, context);
        if (!next.ok) {
          incompleteReasons.push(next.error.code);
          await this.releaseCursorState(lease, state, context);
          delete state.current;
          continue;
        }
        current.references = next.value.references;
        current.index = 0;
        if (next.value.continuationPoint === undefined) delete current.continuationPoint;
        else current.continuationPoint = next.value.continuationPoint;
        continue;
      }
      delete state.current;
    }

    const hasWork = this.hasBrowseWork(state);
    const uniqueReasons = [...new Set(incompleteReasons)];
    const canResume =
      hasWork && uniqueReasons.every((reason) => reason === 'page_size' || reason === 'response_size');
    if (hasWork && uniqueReasons.length === 0) uniqueReasons.push('page_size');
    let continuation: string | undefined;
    if (canResume) {
      const cursor = this.createBrowseCursor(state);
      if (cursor === undefined) {
        await this.releaseCursorState(lease, state, context);
        delete state.current;
        return failure('server_busy', 'The browse cursor capacity is exhausted.');
      }
      continuation = cursor;
    } else if (hasWork) {
      await this.releaseCursorState(lease, state, context);
      delete state.current;
      state.frontier.length = 0;
    }
    const response = this.browseResponse(
      state.start,
      state.generation,
      edges,
      observedAt,
      !hasWork && uniqueReasons.length === 0,
      uniqueReasons,
      continuation,
    );
    if (serializedBytes(response) > this.options.maximumResponseBytes) {
      if (continuation !== undefined) this.cursors.delete(continuation);
      await this.releaseCursorState(lease, state, context);
      delete state.current;
      return failure('response_limit_exceeded', 'The browse response exceeds the configured size limit.');
    }
    if (replayToken !== undefined) {
      const cursor = this.cursors.get(replayToken);
      if (cursor !== undefined) cursor.expiresAt = Date.now() + this.options.cursorTtlMs;
    }
    return response;
  }

  private hasBrowseWork(state: BrowseCursorState): boolean {
    return (
      (state.current !== undefined &&
        (state.current.index < state.current.references.length ||
          state.current.continuationPoint !== undefined)) ||
      state.frontier.length > 0
    );
  }

  private createBrowseCursor(state: BrowseCursorState): string | undefined {
    if (this.cursors.size >= this.options.maximumActiveCursors) return undefined;
    const token = randomUUID();
    this.cursors.set(token, {
      generation: state.generation,
      state,
      expiresAt: Date.now() + this.options.cursorTtlMs,
    });
    return token;
  }

  private async cleanupExpiredCursors(
    lease: ReadOnlyOpcUaSessionLease,
    context: ProtocolOperationContext,
  ): Promise<void> {
    const now = Date.now();
    for (const [token, cursor] of this.cursors) {
      if (cursor.expiresAt > now) continue;
      this.cursors.delete(token);
      if (cursor.state !== undefined)
        await this.releaseCursorState(lease, cursor.state, context);
    }
  }

  private async releaseCursorState(
    lease: ReadOnlyOpcUaSessionLease,
    state: BrowseCursorState,
    context: ProtocolOperationContext,
  ): Promise<void> {
    const point = state.current?.continuationPoint;
    if (point !== undefined) {
      try {
        await lease.releaseContinuationPoints([point], context);
      } catch {
        // Cleanup is best effort when the session is already changing or closed.
      }
    }
  }

  private browseResponse(
    start: QualifiedNodeIdentity,
    generation: number,
    edges: BrowseEdge[],
    observedAt: string,
    complete: boolean,
    incompleteReasons: string[],
    continuation: string | undefined,
  ): BrowseResult {
    return {
      ok: true,
      observedAt,
      connectionGeneration: generation,
      start,
      edges,
      complete,
      incompleteReasons,
      ...(continuation === undefined ? {} : { continuation }),
    };
  }

  async inspect(request: InspectRequest, signal?: AbortSignal): Promise<InspectResult> {
    if (!this.acquireOperation()) return failure('server_busy', 'The inspection server is busy.');
    const selectors = 'selector' in request ? [request.selector] : request.selectors;
    const context = this.context(signal);
    try {
      const validation = validateNodeSelectorBatch(selectors, {
        maximumBatchSize: this.options.maximumInspectionBatchSize,
        parseNodeId: parseCanonicalNodeId,
        ...(this.options.resolveLabel === undefined
          ? {}
          : { resolveLabel: this.options.resolveLabel }),
      });
      if (!validation.ok) return validation;
      return await this.withLease(context, async (lease) => {
        const table = await this.loadNamespaceTable(lease, context);
        const validItems = validation.items.filter((item) => item.validation.ok);
        const reads = validItems.flatMap((item) => {
          const selectorValidation = item.validation;
          if (!selectorValidation.ok) return [];
          return INSPECTION_ATTRIBUTES.map((attributeId) => ({
            nodeId: selectorValidation.canonicalNodeId,
            attributeId,
          }));
        });
        const readResult =
          reads.length === 0
            ? { ok: true as const, value: [] }
            : await this.readBounded(lease, reads, context);
        const values = readResult.ok ? readResult.value : [];
        const entries: InspectEntry[] = [];
        let valueIndex = 0;

        for (const item of validation.items) {
          const selectorValidation = item.validation;
          if (!selectorValidation.ok) {
            entries.push({
              index: item.index,
              selector: item.selector,
              state: 'failed',
              identity: fieldFailed('invalid_selector', selectorValidation.error.message),
              fields: emptyInspectFields(),
              error: selectorValidation.error,
            });
            continue;
          }
          const identity = this.qualifyNodeId(selectorValidation.canonicalNodeId, table);
          if (!readResult.ok) {
            const error = protocolFailureToInspection(readResult);
            entries.push({
              index: item.index,
              selector: item.selector,
              state: 'failed',
              identity: fieldPresent(identity),
              fields: emptyInspectFields(),
              error,
            });
            continue;
          }
          const itemValues = values.slice(valueIndex, valueIndex + INSPECTION_ATTRIBUTES.length);
          valueIndex += INSPECTION_ATTRIBUTES.length;
          const fields = await this.buildInspectFields(lease, itemValues, identity, table, context);
          const state: ItemState = hasFailedField(fields) ? 'partial' : 'success';
          entries.push({
            index: item.index,
            selector: item.selector,
            state,
            identity: fieldPresent(identity),
            fields,
            ...(state === 'partial'
              ? {
                  error: {
                    code: 'opcua_operation_failed',
                    message: 'Some inspection fields were unavailable.',
                  },
                }
              : {}),
          });
        }
        return fitInspectResponse(
          {
            ok: true,
            observedAt: this.observedAt(),
            connectionGeneration: lease.connectionGeneration,
            items: entries,
          },
          this.options.maximumResponseBytes,
        );
      });
    } catch (error) {
      return failureFrom(error);
    } finally {
      this.releaseOperation();
    }
  }

  async read(request: ReadRequest, signal?: AbortSignal): Promise<ReadResult> {
    if (!this.acquireOperation()) return failure('server_busy', 'The inspection server is busy.');
    const selectors = 'selector' in request ? [request.selector] : request.selectors;
    const context = this.context(signal);
    try {
      const validation = validateNodeSelectorBatch(selectors, {
        maximumBatchSize: this.options.maximumReadBatchSize,
        parseNodeId: parseCanonicalNodeId,
        ...(this.options.resolveLabel === undefined
          ? {}
          : { resolveLabel: this.options.resolveLabel }),
      });
      if (!validation.ok) return validation;
      return await this.withLease(context, async (lease) => {
        const table = await this.loadNamespaceTable(lease, context);
        const validItems = validation.items.filter((item) => item.validation.ok);
        const native = validItems.flatMap((item) => {
          const selectorValidation = item.validation;
          return selectorValidation.ok
            ? [{ nodeId: selectorValidation.canonicalNodeId, attributeId: ATTRIBUTE_VALUE }]
            : [];
        });
        const nativeResult =
          native.length === 0
            ? { ok: true as const, value: [] }
            : await this.readBounded(lease, native, context);
        const entries: ReadEntry[] = [];
        let valueIndex = 0;
        for (const item of validation.items) {
          const selectorValidation = item.validation;
          if (!selectorValidation.ok) {
            entries.push({
              index: item.index,
              selector: item.selector,
              state: 'failed',
              error: selectorValidation.error,
            });
            continue;
          }
          const identity = this.qualifyNodeId(selectorValidation.canonicalNodeId, table);
          if (!nativeResult.ok) {
            entries.push({
              index: item.index,
              selector: item.selector,
              state: 'failed',
              identity,
              error: protocolFailureToInspection(nativeResult),
            });
            continue;
          }
          const value = nativeResult.value[valueIndex];
          valueIndex += 1;
          if (value === undefined) {
            entries.push({
              index: item.index,
              selector: item.selector,
              state: 'failed',
              identity,
              error: failure(
                'opcua_operation_failed',
                'The OPC UA Server returned an incomplete Read response.',
              ).error,
            });
            continue;
          }
          entries.push(
            await this.buildReadEntry(
              lease,
              item.index,
              item.selector,
              identity,
              value,
              table,
              context,
            ),
          );
        }
        return fitReadResponse(
          {
            ok: true,
            observedAt: this.observedAt(),
            connectionGeneration: lease.connectionGeneration,
            items: entries,
          },
          this.options.maximumResponseBytes,
        );
      });
    } catch (error) {
      return failureFrom(error);
    } finally {
      this.releaseOperation();
    }
  }

  clearGenerationState(): void {
    this.cursors.clear();
    this.readChunkSizes.clear();
    this.namespaceCache.clear();
    this.namespaceZeroNameCache.clear();
  }

  async modelContext(signal?: AbortSignal): Promise<ModelContextResult> {
    if (!this.acquireOperation()) return failure('server_busy', 'The inspection server is busy.');
    const context = this.context(signal);
    try {
      return await this.withLease(context, async (lease) => {
        const observedAt = this.observedAt();
        const table = await this.loadNamespaceTable(lease, context);
        if (table.values === undefined)
          return failure(table.error.code, table.error.message, table.error.statusCode);
        const metadata = await this.discoverNamespaceMetadata(lease, table.values, context);
        const namespaces: NamespaceContext[] = [];
        let responseLimitReached = false;
        for (let index = 0; index < table.values.length; index += 1) {
          const uri = table.values[index];
          const namespaceUri =
            typeof uri === 'string' && uri.length > 0
              ? fieldPresent(uri)
              : fieldFailed('namespace_unavailable', 'The namespace table entry is unavailable.');
          const metadataValue = typeof uri === 'string' ? metadata.byUri.get(uri) : undefined;
          const entry: NamespaceContext = {
            namespaceIndex: index,
            namespaceUri,
            metadata: metadataValue ?? metadata.defaultOutcome,
          };
          const candidate = [...namespaces, entry];
          const response = {
            ok: true as const,
            observedAt,
            connectionGeneration: lease.connectionGeneration,
            namespaces: candidate,
            complete: true,
          };
          const limitedResponse = {
            ...response,
            complete: false,
            limitReason: 'response_size' as const,
          };
          if (
            serializedBytes(response) > this.options.maximumResponseBytes ||
            serializedBytes(limitedResponse) > this.options.maximumResponseBytes
          ) {
            responseLimitReached = true;
            break;
          }
          namespaces.push(entry);
        }
        const result: ModelContextSuccess = {
          ok: true,
          observedAt,
          connectionGeneration: lease.connectionGeneration,
          namespaces,
          complete: !responseLimitReached,
          ...(responseLimitReached ? { limitReason: 'response_size' as const } : {}),
        };
        return result;
      });
    } catch (error) {
      return failureFrom(error);
    } finally {
      this.releaseOperation();
    }
  }

  private acquireOperation(): boolean {
    if (this.activeOperations >= this.options.maximumConcurrentOperations) return false;
    this.activeOperations += 1;
    return true;
  }

  private releaseOperation(): void {
    this.activeOperations -= 1;
  }

  private async withLease<T>(
    context: ProtocolOperationContext,
    operation: (lease: ReadOnlyOpcUaSessionLease) => Promise<T>,
  ): Promise<T> {
    return runWithProtocolFailure(this.adapter, operation, context);
  }

  private context(signal?: AbortSignal): ProtocolOperationContext {
    return {
      ...(signal === undefined ? {} : { signal }),
      deadlineAt: Date.now() + this.options.operationDeadlineMs,
    };
  }

  private observedAt(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private qualifyNodeId(nodeId: string, table: NamespaceTable): QualifiedNodeIdentity {
    const namespaceIndex = namespaceIndexOf(nodeId);
    return {
      nodeId,
      namespaceIndex,
      namespaceUri: this.namespaceOutcome(namespaceIndex, table),
    };
  }

  private qualifyName(value: ProtocolQualifiedName, table: NamespaceTable): QualifiedNameIdentity {
    return {
      namespaceIndex: value.namespaceIndex,
      name: value.name,
      namespaceUri: this.namespaceOutcome(value.namespaceIndex, table),
    };
  }

  private namespaceOutcome(namespaceIndex: number, table: NamespaceTable): FieldOutcome<string> {
    if (namespaceIndex === 0) return fieldPresent(STANDARD_NAMESPACE_URI);
    const uri = table.values?.[namespaceIndex];
    if (typeof uri === 'string' && uri.length > 0) return fieldPresent(uri);
    return fieldFailed('namespace_unavailable', 'The OPC UA namespace URI could not be resolved.');
  }

  private async loadNamespaceTable(
    lease: ReadOnlyOpcUaSessionLease,
    context: ProtocolOperationContext,
  ): Promise<NamespaceTable> {
    const cached = this.namespaceCache.get(lease.connectionGeneration, 0);
    if (cached !== undefined) return { values: cached, error: noError() };
    const result = await lease.readNamespaceArray(context);
    if (!result.ok) return { error: protocolFailureToInspection(result) };
    const values = [...result.value];
    this.namespaceCache.set(lease.connectionGeneration, 0, values);
    return { values, error: noError() };
  }

  private async readBounded(
    lease: ReadOnlyOpcUaSessionLease,
    requests: ProtocolReadRequest[],
    context: ProtocolOperationContext,
  ): Promise<ProtocolResult<ProtocolDataValue[]>> {
    let chunkSize =
      this.readChunkSizes.get(lease.connectionGeneration, 0) ?? this.options.maximumReadBatchSize;
    const advertised = await lease.readOperationLimits(context);
    if (advertised.ok && advertised.value.maxNodesPerRead !== undefined) {
      chunkSize = Math.min(chunkSize, advertised.value.maxNodesPerRead);
    }
    chunkSize = Math.max(1, chunkSize);
    const values: ProtocolDataValue[] = [];
    let offset = 0;
    while (offset < requests.length) {
      let currentSize = Math.min(chunkSize, requests.length - offset);
      let result: ProtocolResult<ProtocolDataValue[]> | undefined;
      let retry = true;
      while (retry) {
        retry = false;
        result = undefined;
        try {
          result = await lease.read(requests.slice(offset, offset + currentSize), context);
        } catch (error) {
          if (!isOversizedReadError(error) || currentSize <= 1) throw error;
          currentSize = Math.max(1, Math.floor(currentSize / 2));
          chunkSize = currentSize;
          this.readChunkSizes.set(lease.connectionGeneration, 0, currentSize);
          retry = true;
        }
        if (result !== undefined && !result.ok && isOversizedReadFailure(result) && currentSize > 1) {
          currentSize = Math.max(1, Math.floor(currentSize / 2));
          chunkSize = currentSize;
          this.readChunkSizes.set(lease.connectionGeneration, 0, currentSize);
          retry = true;
        }
      }
      if (result === undefined) throw new OpcUaProtocolError('opcua_operation_failed', 'The OPC UA Read returned no result.');
      if (!result.ok) return result;
      values.push(...result.value);
      offset += currentSize;
    }
    return { ok: true, value: values };
  }

  private async resolveNodeIdentity(
    lease: ReadOnlyOpcUaSessionLease,
    nodeId: string,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<ResolvedNodeIdentity> {
    const identity = this.qualifyNodeId(nodeId, table);
    const standardName = this.standardNodeName(lease.connectionGeneration, nodeId);
    if (standardName !== undefined) return { ...identity, name: fieldPresent(standardName) };
    const result = await lease.read([{ nodeId, attributeId: ATTRIBUTE_BROWSE_NAME }], context);
    if (!result.ok)
      return {
        ...identity,
        name: fieldFailed('name_unavailable', protocolFailureToInspection(result).message),
      };
    const value = result.value[0];
    const browseName = value === undefined ? undefined : asQualifiedName(value.value);
    if (value === undefined || value.quality === 'bad' || browseName === undefined) {
      return {
        ...identity,
        name: fieldFromDataValue(
          value,
          'name_unavailable',
          'The qualified name could not be resolved.',
        ),
      };
    }
    return { ...identity, name: fieldPresent(browseName.name, value.statusCode) };
  }

  private standardNodeName(generation: number, nodeId: string): string | undefined {
    const cached = this.namespaceZeroNameCache.get(generation, nodeId);
    if (cached !== undefined) return cached;
    if (namespaceIndexOf(nodeId) !== 0) return undefined;
    const numeric = numericIdentifier(nodeId);
    if (numeric === undefined) return undefined;
    const name = getStandardNames().get(numeric);
    if (name !== undefined) this.namespaceZeroNameCache.set(generation, nodeId, name);
    return name;
  }

  private async buildInspectFields(
    lease: ReadOnlyOpcUaSessionLease,
    values: ProtocolDataValue[],
    identity: QualifiedNodeIdentity,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<InspectFields> {
    const byAttribute = new Map(
      INSPECTION_ATTRIBUTES.map((attribute, index) => [attribute, values[index]]),
    );
    const browseName = fieldFromQualifiedName(byAttribute.get(ATTRIBUTE_BROWSE_NAME), table);
    const nodeClass = fieldFromDataValue(
      byAttribute.get(ATTRIBUTE_NODE_CLASS),
      'node_class_unavailable',
      'The NodeClass could not be read.',
      mapNodeClass,
    );
    const displayName = fieldFromLocalizedText(byAttribute.get(ATTRIBUTE_DISPLAY_NAME));
    const description = fieldFromLocalizedText(byAttribute.get(ATTRIBUTE_DESCRIPTION));
    const dataTypeRaw = byAttribute.get(ATTRIBUTE_DATA_TYPE);
    const dataType = await this.resolvedNodeIdField(
      lease,
      dataTypeRaw,
      table,
      context,
      'datatype_unavailable',
    );
    const valueRank = fieldFromNumber(
      byAttribute.get(ATTRIBUTE_VALUE_RANK),
      'value_rank_unavailable',
    );
    const accessLevel = fieldFromAccessLevel(byAttribute.get(ATTRIBUTE_ACCESS_LEVEL));
    const userAccessLevel = fieldFromAccessLevel(byAttribute.get(ATTRIBUTE_USER_ACCESS_LEVEL));
    const executable = fieldFromBoolean(
      byAttribute.get(ATTRIBUTE_EXECUTABLE),
      'executable_unavailable',
    );
    const userExecutable = fieldFromBoolean(
      byAttribute.get(ATTRIBUTE_USER_EXECUTABLE),
      'user_executable_unavailable',
    );
    const typeDefinition = await this.findTypeDefinition(lease, identity.nodeId, table, context);
    const diagnostics = await this.readDiagnosticProperties(
      lease,
      identity.nodeId,
      table,
      context,
    );
    return {
      browseName,
      nodeClass,
      displayName,
      description,
      typeDefinition,
      dataType,
      valueRank,
      accessLevel,
      userAccessLevel,
      executable,
      userExecutable,
      currentlyReadable: accessIndicator(userAccessLevel, 'currentRead'),
      currentlyWritable: accessIndicator(userAccessLevel, 'currentWrite'),
      currentlyExecutable: userExecutable,
      ...diagnostics,
    };
  }

  private async resolvedNodeIdField(
    lease: ReadOnlyOpcUaSessionLease,
    value: ProtocolDataValue | undefined,
    table: NamespaceTable,
    context: ProtocolOperationContext,
    code: string,
  ): Promise<FieldOutcome<ResolvedNodeIdentity>> {
    const raw = value?.value;
    const nodeId = canonicalizeUnknownNodeId(raw);
    if (nodeId === undefined)
      return fieldFromDataValue(value, code, 'The NodeId identity could not be read.');
    if (value?.quality === 'bad')
      return fieldFromDataValue(value, code, 'The NodeId identity could not be read.');
    return fieldPresent(
      await this.resolveNodeIdentity(lease, nodeId, table, context),
      value?.statusCode,
    );
  }

  private async findTypeDefinition(
    lease: ReadOnlyOpcUaSessionLease,
    nodeId: string,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<FieldOutcome<ResolvedNodeIdentity>> {
    const result = await browseAllPages(
      lease,
      {
        nodeId,
        direction: 'forward',
        referenceTypeId: HAS_TYPE_DEFINITION,
        includeSubtypes: false,
        nodeClassMask: 0,
        requestedMaxReferencesPerNode: 10,
      },
      context,
    );
    if (!result.ok)
      return fieldFailed(result.error.code, result.error.message, result.error.statusCode);
    const reference = result.value.references[0];
    if (reference === undefined) return { state: 'not_present' };
    const target = canonicalizeBestEffort(reference.nodeId);
    if (target === undefined)
      return fieldFailed('type_definition_unavailable', 'The TypeDefinition identity is invalid.');
    return fieldPresent(await this.resolveNodeIdentity(lease, target, table, context));
  }

  private async buildReadEntry(
    lease: ReadOnlyOpcUaSessionLease,
    index: number,
    selector: NodeSelector,
    identity: QualifiedNodeIdentity,
    value: ProtocolDataValue,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<ReadValueEntry> {
    const quality = value.quality;
    const dataTypeNodeId = dataTypeNodeIdFromProtocol(value.dataType);
    const dataType =
      dataTypeNodeId === undefined
        ? fieldFailed(
            'datatype_unavailable',
            'The DataType identity was not supplied by the Server.',
          )
        : fieldPresent(await this.resolveNodeIdentity(lease, dataTypeNodeId, table, context));
    if (quality === 'bad') {
      return {
        index,
        selector,
        state: 'partial',
        identity,
        dataType,
        statusCode: value.statusCode,
        quality,
        usable: false,
        value: fieldFromDataValue(value, 'value_unavailable', 'The value is not usable.'),
        conversion: {
          state: 'failed',
          code: 'value_unavailable',
          message: 'The value is not usable.',
        },
        ...timestamps(value),
      };
    }
    const converted = convertValue(
      value.value,
      value.dataType,
      value.arrayType,
      this.options.maximumArrayElements,
    );
    if (!converted.ok) {
      return {
        index,
        selector,
        state: 'partial',
        identity,
        dataType,
        statusCode: value.statusCode,
        quality,
        usable: false,
        value: { state: converted.state, code: converted.code, message: converted.message },
        conversion: { state: converted.state, code: converted.code, message: converted.message },
        ...timestamps(value),
      };
    }
    return {
      index,
      selector,
      state: 'success',
      identity,
      dataType,
      statusCode: value.statusCode,
      quality,
      usable: true,
      value: fieldPresent(converted.value, value.statusCode),
      conversion: { state: 'converted' },
      ...timestamps(value),
    };
  }

  private async readDiagnosticProperties(
    lease: ReadOnlyOpcUaSessionLease,
    nodeId: string,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<
    Pick<
      InspectFields,
      'engineeringUnits' | 'euRange' | 'instrumentRange' | 'enumStrings' | 'enumValues'
    >
  > {
    const result = await browseAllPages(
      lease,
      {
        nodeId,
        direction: 'forward',
        referenceTypeId: HAS_PROPERTY,
        includeSubtypes: false,
        nodeClassMask: 0,
        requestedMaxReferencesPerNode: 25,
      },
      context,
    );
    if (!result.ok) {
      const failed = fieldFailed(result.error.code, result.error.message, result.error.statusCode);
      return {
        engineeringUnits: failed,
        euRange: failed,
        instrumentRange: failed,
        enumStrings: failed,
        enumValues: failed,
      };
    }
    const byName = new Map<string, ProtocolReference[]>();
    for (const reference of result.value.references) {
      const browseName = reference.browseName;
      const referenceTypeId = canonicalizeBestEffort(reference.referenceTypeId);
      const propertyType = canonicalizeBestEffort(reference.typeDefinition ?? '');
      if (
        referenceTypeId !== HAS_PROPERTY ||
        browseName?.namespaceIndex !== 0 ||
        propertyType !== 'ns=0;i=68'
      ) {
        continue;
      }
      const name = browseName.name;
      byName.set(name, [...(byName.get(name) ?? []), reference]);
    }
    const definitions = [
      ['EngineeringUnits', 'engineering_units_unavailable', decodeEngineeringUnits],
      ['EURange', 'eu_range_unavailable', decodeRange],
      ['InstrumentRange', 'instrument_range_unavailable', decodeRange],
      ['EnumStrings', 'enum_strings_unavailable', decodeLocalizedTextArray],
      ['EnumValues', 'enum_values_unavailable', decodeEnumValues],
    ] as const;
    const outcomes = new Map<string, FieldOutcome<unknown>>();
    for (const [name, code, decode] of definitions)
      outcomes.set(
        name,
        propertyOutcome<unknown>(
          await this.readDiagnosticProperty(byName, name, lease, table, context),
          code,
          decode,
          this.options.maximumArrayElements,
        ),
      );
    for (const [name, matches] of byName) {
      if (matches.length > 1 && outcomes.has(name))
        outcomes.set(name, fieldFailed('ambiguous_source', `The ${name} property source is ambiguous.`));
    }
    return {
      engineeringUnits: diagnosticOutcome(outcomes, 'EngineeringUnits'),
      euRange: diagnosticOutcome(outcomes, 'EURange'),
      instrumentRange: diagnosticOutcome(outcomes, 'InstrumentRange'),
      enumStrings: diagnosticOutcome(outcomes, 'EnumStrings'),
      enumValues: diagnosticOutcome(outcomes, 'EnumValues'),
    };
  }

  private async readDiagnosticProperty(
    byName: Map<string, ProtocolReference[]>,
    name: string,
    lease: ReadOnlyOpcUaSessionLease,
    table: NamespaceTable,
    context: ProtocolOperationContext,
  ): Promise<PropertyRead | undefined> {
    const matches = byName.get(name) ?? [];
    if (matches.length !== 1) return undefined;
    const property = matches[0];
    if (property === undefined) return undefined;
    const propertyId = canonicalizeBestEffort(property.nodeId);
    if (propertyId === undefined) return undefined;
    const source = this.qualifyNodeId(propertyId, table);
    const read = await lease.read([{ nodeId: propertyId, attributeId: ATTRIBUTE_VALUE }], context);
    if (read.ok) {
      const value = read.value[0];
      return { value: value ?? { statusCode: 'Unknown', quality: 'bad' }, source };
    }
    return {
      value: { statusCode: read.error.statusCode ?? 'Unknown', quality: 'bad' },
      source,
    };
  }

  private async discoverNamespaceMetadata(
    lease: ReadOnlyOpcUaSessionLease,
    namespaceUris: string[],
    context: ProtocolOperationContext,
  ): Promise<MetadataDiscovery> {
    const root = await browseAllPages(
      lease,
      {
        nodeId: SERVER_NAMESPACES,
        direction: 'forward',
        referenceTypeId: HAS_COMPONENT,
        includeSubtypes: false,
        nodeClassMask: 0,
        requestedMaxReferencesPerNode: this.options.maximumBrowsePageSize,
      },
      context,
    );
    if (!root.ok) {
      const missing = root.error.code === 'node_not_found';
      const failure = missing
        ? ({ state: 'not_present' } as const)
        : fieldFailed(root.error.code, root.error.message, root.error.statusCode);
      return {
        byUri: new Map(),
        defaultOutcome: failure,
      };
    }
    const drafts: MetadataDraft[] = [];
    for (const reference of root.value.references) {
      const nodeId = canonicalizeBestEffort(reference.nodeId);
      if (nodeId === undefined) continue;
      const propertyBrowse = await browseAllPages(
        lease,
        {
          nodeId,
          direction: 'forward',
          referenceTypeId: HAS_PROPERTY,
          includeSubtypes: false,
          nodeClassMask: 0,
          requestedMaxReferencesPerNode: 25,
        },
        context,
      );
      if (!propertyBrowse.ok) {
        const draft: MetadataDraft = { failure: protocolFailureToInspection(propertyBrowse) };
        if (reference.browseName?.name !== undefined) draft.browseName = reference.browseName.name;
        drafts.push(draft);
        continue;
      }
      const properties = new Map<string, string>();
      for (const property of propertyBrowse.value.references) {
        const name = property.browseName?.name;
        const propertyId = canonicalizeBestEffort(property.nodeId);
        if (name !== undefined && propertyId !== undefined && !properties.has(name))
          properties.set(name, propertyId);
      }
      const reads = [...['NamespaceUri', 'NamespaceVersion', 'NamespacePublicationDate']].flatMap(
        (name) => {
          const propertyId = properties.get(name);
          return propertyId === undefined
            ? []
            : [{ name, request: { nodeId: propertyId, attributeId: ATTRIBUTE_VALUE } }];
        },
      );
      const values =
        reads.length === 0
          ? { ok: true as const, value: [] }
          : await this.readBounded(
              lease,
              reads.map((entry) => entry.request),
              context,
            );
      const fields: NamespaceModelMetadata = {
        modelUri: metadataField(values, reads, 'NamespaceUri', decodeString),
        version: metadataField(values, reads, 'NamespaceVersion', decodeString),
        publicationDate: metadataField(values, reads, 'NamespacePublicationDate', decodeDateTime),
      };
      const draft: MetadataDraft = { fields };
      if (reference.browseName?.name !== undefined) draft.browseName = reference.browseName.name;
      if (fields.modelUri.state === 'present') draft.modelUri = fields.modelUri.value;
      drafts.push(draft);
    }
    const byUri = new Map<string, FieldOutcome<NamespaceModelMetadata>>();
    for (const draft of drafts) {
      const uri = draft.modelUri ?? draft.browseName;
      if (uri === undefined || !namespaceUris.includes(uri)) continue;
      if (draft.fields !== undefined) byUri.set(uri, fieldPresent(draft.fields));
      else if (draft.failure !== undefined)
        byUri.set(
          uri,
          fieldFailed(draft.failure.code, draft.failure.message, draft.failure.statusCode),
        );
    }
    return { byUri, defaultOutcome: { state: 'not_present' } };
  }
}

export function createOpcUaInspectionModule(
  adapter: ReadOnlyOpcUaProtocolAdapter,
  options?: OpcUaInspectionModuleOptions,
): OpcUaInspectionModule {
  return new OpcUaInspectionService(adapter, options);
}

interface BrowseWorkItem {
  nodeId: string;
  identity: QualifiedNodeIdentity;
  depth: number;
  path: BrowsePathEdge[];
}

interface BrowseCursorState {
  generation: number;
  start: QualifiedNodeIdentity;
  selector: string;
  direction: 'forward' | 'inverse' | 'both';
  referenceTypeId: string;
  nodeClassMask: number;
  targetNodeClasses?: NodeClass[];
  depth: number;
  pageSize: number;
  nativePageSize: number;
  frontier: BrowseWorkItem[];
  seen: Set<string>;
  current?: BrowseCurrent;
  edgesReturned: number;
  scannedReferences: number;
  expandedNodes: number;
  serviceCalls: number;
}

interface BrowseCurrent {
  item: BrowseWorkItem;
  references: ProtocolReference[];
  index: number;
  continuationPoint?: Uint8Array;
}

interface BrowseCursor {
  generation: number;
  state?: BrowseCursorState;
  response?: BrowseSuccess;
  pending?: Promise<BrowseResult>;
  expiresAt: number;
}

interface PropertyRead {
  value: ProtocolDataValue;
  source: QualifiedNodeIdentity;
}

interface NamespaceTable {
  values?: string[];
  error: InspectionError;
}

interface MetadataDraft {
  browseName?: string;
  modelUri?: string;
  fields?: NamespaceModelMetadata;
  failure?: InspectionError;
}

interface MetadataDiscovery {
  byUri: Map<string, FieldOutcome<NamespaceModelMetadata>>;
  defaultOutcome: FieldOutcome<NamespaceModelMetadata>;
}

const INSPECTION_ATTRIBUTES = [
  ATTRIBUTE_NODE_ID,
  ATTRIBUTE_NODE_CLASS,
  ATTRIBUTE_BROWSE_NAME,
  ATTRIBUTE_DISPLAY_NAME,
  ATTRIBUTE_DESCRIPTION,
  ATTRIBUTE_DATA_TYPE,
  ATTRIBUTE_VALUE_RANK,
  ATTRIBUTE_ACCESS_LEVEL,
  ATTRIBUTE_USER_ACCESS_LEVEL,
  ATTRIBUTE_EXECUTABLE,
  ATTRIBUTE_USER_EXECUTABLE,
];

async function runWithProtocolFailure<T>(
  adapter: ReadOnlyOpcUaProtocolAdapter,
  operation: (lease: ReadOnlyOpcUaSessionLease) => Promise<T>,
  context: ProtocolOperationContext,
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

async function browseAllPages(
  lease: ReadOnlyOpcUaSessionLease,
  request: ProtocolBrowseRequest,
  context: ProtocolOperationContext,
): Promise<ProtocolResult<ProtocolBrowsePage>> {
  const first = await lease.browse(request, context);
  if (!first.ok) return first;
  const references = [...first.value.references];
  let continuation = first.value.continuationPoint;
  while (continuation !== undefined) {
    const next = await lease.browseNext(continuation, context);
    if (!next.ok) return next;
    references.push(...next.value.references);
    continuation = next.value.continuationPoint;
  }
  return { ok: true, value: { statusCode: first.value.statusCode, references } };
}

function fitInspectResponse(response: InspectSuccess, maximumBytes: number): InspectResult {
  if (serializedBytes(response) <= maximumBytes) return response;
  const items = response.items.map((item) => ({ ...item, fields: { ...item.fields } }));
  const fields = items.flatMap((item) =>
    (Object.keys(item.fields) as (keyof InspectFields)[]).map((key) => ({
      item,
      key,
      size: serializedBytes(item.fields[key]),
    })),
  );
  fields.sort((left, right) => right.size - left.size);
  for (const entry of fields) {
    if (serializedBytes({ ...response, items }) <= maximumBytes) break;
    const field = entry.item.fields[entry.key];
    if (field.state === 'failed' && field.code === 'response_limit_exceeded') continue;
    entry.item.fields[entry.key] = responseLimitField();
    entry.item.state = 'partial';
    entry.item.error = {
      code: 'response_limit_exceeded',
      message: 'Some inspection fields were omitted because the response exceeded its size limit.',
    };
  }
  const result: InspectSuccess = { ...response, items };
  return serializedBytes(result) <= maximumBytes
    ? result
    : failure('response_limit_exceeded', 'The inspection response exceeds the configured size limit.');
}

function fitReadResponse(response: ReadSuccess, maximumBytes: number): ReadResult {
  if (serializedBytes(response) <= maximumBytes) return response;
  const items = response.items.map((item) => ({ ...item }));
  for (const item of items) {
    if (serializedBytes({ ...response, items }) <= maximumBytes) break;
    if (item.state !== 'failed') {
      item.state = 'partial';
      item.value = responseLimitField();
      item.conversion = {
        state: 'failed',
        code: 'response_limit_exceeded',
        message: 'The value was omitted because the response exceeded its size limit.',
      };
      item.error = {
        code: 'response_limit_exceeded',
        message: 'The value was omitted because the response exceeded its size limit.',
      };
    }
  }
  const result: ReadSuccess = { ...response, items };
  return serializedBytes(result) <= maximumBytes
    ? result
    : failure('response_limit_exceeded', 'The read response exceeds the configured size limit.');
}

function responseLimitField(): { state: 'failed'; code: string; message: string } {
  return {
    state: 'failed',
    code: 'response_limit_exceeded',
    message: 'The field was omitted because the response exceeded its size limit.',
  };
}

function failure(
  code: InspectionError['code'],
  message: string,
  statusCode?: string,
): { ok: false; error: InspectionError } {
  return {
    ok: false,
    error: {
      code,
      message: sanitizeMessage(message),
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

function failureFrom(error: unknown): { ok: false; error: InspectionError } {
  if (error instanceof OpcUaProtocolError)
    return failure(inspectionCode(error.code), error.message, error.statusCode);
  return failure(
    'opcua_operation_failed',
    error instanceof Error ? error.message : 'The OPC UA operation failed.',
  );
}

function isOversizedReadError(error: unknown): boolean {
  const code = error instanceof OpcUaProtocolError ? error.code : isRecord(error) ? error['code'] : undefined;
  const statusCode =
    error instanceof OpcUaProtocolError
      ? (error.statusCode ?? '')
      : isRecord(error) && typeof error['statusCode'] === 'string'
        ? error['statusCode']
        : typeof code === 'string' && code.startsWith('Bad')
          ? code
          : '';
  return (
    code === 'invalid_request' ||
    statusCode.includes('TooManyOperations') ||
    statusCode.includes('TooManyNodes') ||
    statusCode.includes('RequestTooLarge') ||
    statusCode.includes('ResponseTooLarge')
  );
}

function isOversizedReadFailure(
  result: ProtocolResult<ProtocolDataValue[]>,
): result is ProtocolFailure {
  return !result.ok && isOversizedReadError(result.error);
}

function protocolFailureToInspection(result: ProtocolFailure): InspectionError {
  const code = inspectionCode(result.error.code);
  return {
    code,
    message: sanitizeMessage(result.error.message),
    ...(result.error.statusCode === undefined ? {} : { statusCode: result.error.statusCode }),
  };
}

function inspectionCode(code: string): InspectionError['code'] {
  switch (code) {
    case 'connection_changed':
    case 'invalid_continuation':
    case 'invalid_request':
    case 'node_not_found':
    case 'opcua_access_denied':
    case 'opcua_operation_failed':
    case 'operation_cancelled':
    case 'operation_timeout':
    case 'server_busy':
      return code;
    default:
      return 'opcua_operation_failed';
  }
}

function noError(): InspectionError {
  return { code: 'opcua_operation_failed', message: '' };
}

function fieldPresent<T>(
  value: T,
  statusCode?: string,
  source?: QualifiedNodeIdentity,
): FieldOutcome<T> {
  return {
    state: 'present',
    value,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(source === undefined ? {} : { source }),
  };
}

function fieldFailed<T = never>(
  code: string,
  message: string,
  statusCode?: string,
): FieldOutcome<T> {
  return {
    state: 'failed',
    code,
    message: sanitizeMessage(message),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function fieldFromDataValue<T>(
  value: ProtocolDataValue | undefined,
  code: string,
  message: string,
  mapper?: (raw: unknown) => FieldOutcome<T>,
): FieldOutcome<T> {
  if (value === undefined) return fieldFailed(code, message);
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad') {
    return {
      state: value.statusCode.includes('AccessDenied') ? 'denied' : 'failed',
      code,
      message,
      statusCode: value.statusCode,
    };
  }
  if (mapper !== undefined) return mapper(value.value);
  return fieldPresent(value.value as T, value.statusCode);
}

function fieldFromQualifiedName(
  value: ProtocolDataValue | undefined,
  table: NamespaceTable,
): FieldOutcome<QualifiedNameIdentity> {
  if (value === undefined)
    return fieldFailed('browse_name_unavailable', 'The BrowseName could not be read.');
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad')
    return fieldFromDataValue(
      value,
      'browse_name_unavailable',
      'The BrowseName could not be read.',
    );
  const qualified = asQualifiedName(value.value);
  return qualified === undefined
    ? fieldFailed(
        'browse_name_unavailable',
        'The BrowseName has an unsupported representation.',
        value.statusCode,
      )
    : fieldPresent(
        { ...qualified, namespaceUri: tableValue(table, qualified.namespaceIndex) },
        value.statusCode,
      );
}

function fieldFromLocalizedText(
  value: ProtocolDataValue | undefined,
): FieldOutcome<LocalizedTextValue> {
  if (value === undefined)
    return fieldFailed('display_name_unavailable', 'The localized text could not be read.');
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad')
    return fieldFromDataValue(
      value,
      'localized_text_unavailable',
      'The localized text could not be read.',
    );
  const mapped = mapLocalizedText(value.value);
  return mapped === undefined
    ? fieldFailed(
        'localized_text_unavailable',
        'The localized text has an unsupported representation.',
        value.statusCode,
      )
    : fieldPresent(mapped, value.statusCode);
}

function fieldFromNumber(value: ProtocolDataValue | undefined, code: string): FieldOutcome<number> {
  if (value === undefined) return fieldFailed(code, 'The numeric attribute could not be read.');
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad')
    return fieldFromDataValue(value, code, 'The numeric attribute could not be read.');
  return typeof value.value === 'number' && Number.isSafeInteger(value.value)
    ? fieldPresent(value.value, value.statusCode)
    : fieldFailed(
        code,
        'The numeric attribute has an unsupported representation.',
        value.statusCode,
      );
}

function fieldFromBoolean(
  value: ProtocolDataValue | undefined,
  code: string,
): FieldOutcome<boolean> {
  if (value === undefined) return fieldFailed(code, 'The Boolean attribute could not be read.');
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad')
    return fieldFromDataValue(value, code, 'The Boolean attribute could not be read.');
  return typeof value.value === 'boolean'
    ? fieldPresent(value.value, value.statusCode)
    : fieldFailed(
        code,
        'The Boolean attribute has an unsupported representation.',
        value.statusCode,
      );
}

function fieldFromAccessLevel(
  value: ProtocolDataValue | undefined,
): FieldOutcome<AccessLevelValue> {
  if (value === undefined)
    return fieldFailed('access_level_unavailable', 'The access level could not be read.');
  if (value.statusCode.includes('AttributeIdInvalid'))
    return { state: 'not_present', statusCode: value.statusCode };
  if (value.quality === 'bad')
    return fieldFromDataValue(
      value,
      'access_level_unavailable',
      'The access level could not be read.',
    );
  if (typeof value.value !== 'number' || !Number.isSafeInteger(value.value))
    return fieldFailed(
      'access_level_unavailable',
      'The access level has an unsupported representation.',
      value.statusCode,
    );
  const raw = value.value;
  return fieldPresent(
    {
      raw,
      currentRead: (raw & 0x01) !== 0,
      currentWrite: (raw & 0x02) !== 0,
      historyRead: (raw & 0x04) !== 0,
      historyWrite: (raw & 0x08) !== 0,
      semanticChange: (raw & 0x10) !== 0,
      statusWrite: (raw & 0x20) !== 0,
      timestampWrite: (raw & 0x40) !== 0,
    },
    value.statusCode,
  );
}

function accessIndicator(
  value: FieldOutcome<AccessLevelValue>,
  indicator: 'currentRead' | 'currentWrite',
): FieldOutcome<boolean> {
  if (value.state === 'present') return fieldPresent(value.value[indicator], value.statusCode);
  if (value.state === 'not_present') return value;
  return {
    state: value.state,
    code: value.code,
    message: value.message,
    ...(value.statusCode === undefined ? {} : { statusCode: value.statusCode }),
  };
}

function tableValue(table: NamespaceTable, index: number): FieldOutcome<string> {
  if (index === 0) return fieldPresent(STANDARD_NAMESPACE_URI);
  const value = table.values?.[index];
  return typeof value === 'string' && value.length > 0
    ? fieldPresent(value)
    : fieldFailed('namespace_unavailable', 'The OPC UA namespace URI could not be resolved.');
}

function asQualifiedName(value: unknown): ProtocolQualifiedName | undefined {
  if (
    isRecord(value) &&
    typeof value['namespaceIndex'] === 'number' &&
    Number.isSafeInteger(value['namespaceIndex']) &&
    typeof value['name'] === 'string'
  )
    return { namespaceIndex: value['namespaceIndex'], name: value['name'] };
  if (typeof value === 'string') {
    const match = /^(\d+):(.*)$/su.exec(value);
    if (match?.[1] !== undefined && match[2] !== undefined)
      return { namespaceIndex: Number(match[1]), name: match[2] };
  }
  return undefined;
}

function mapLocalizedText(value: unknown): ProtocolLocalizedText | undefined {
  if (typeof value === 'string') return { text: value };
  if (!isRecord(value) || typeof value['text'] !== 'string') return undefined;
  return {
    text: value['text'],
    ...(typeof value['locale'] === 'string' ? { locale: value['locale'] } : {}),
  };
}

function referenceDisplayOutcome(value: ProtocolLocalizedText): FieldOutcome<LocalizedTextValue> {
  const mapped = mapLocalizedText(value);
  return mapped === undefined
    ? fieldFailed(
        'display_name_unavailable',
        'The Browse response DisplayName has an unsupported representation.',
      )
    : fieldPresent(mapped);
}

function mapNodeClass(value: unknown): FieldOutcome<NodeClass> {
  const name = typeof value === 'number' ? WELL_KNOWN_OPC_UA_NODE_CLASSES[value] : undefined;
  return name !== undefined && name !== 'Unspecified'
    ? fieldPresent(name as NodeClass)
    : fieldFailed('node_class_unavailable', 'The NodeClass could not be resolved.');
}

function nodeClassMaskFor(classes: NodeClass[] | undefined): number {
  if (classes === undefined || classes.length === 0) return 0;
  return classes.reduce(
    (mask, value) =>
      mask |
      (Object.entries(WELL_KNOWN_OPC_UA_NODE_CLASSES).find(([, name]) => name === value)?.[0] ===
      undefined
        ? 0
        : Number(
            Object.entries(WELL_KNOWN_OPC_UA_NODE_CLASSES).find(([, name]) => name === value)?.[0],
          )),
    0,
  );
}

function emptyInspectFields(): InspectFields {
  const failed = fieldFailed('not_inspected', 'The Node was not inspected.');
  return {
    browseName: failed,
    nodeClass: failed,
    displayName: failed,
    description: failed,
    typeDefinition: failed,
    dataType: failed,
    valueRank: failed,
    accessLevel: failed,
    userAccessLevel: failed,
    executable: failed,
    userExecutable: failed,
    currentlyReadable: failed,
    currentlyWritable: failed,
    currentlyExecutable: failed,
    engineeringUnits: failed,
    euRange: failed,
    instrumentRange: failed,
    enumStrings: failed,
    enumValues: failed,
  };
}

function hasFailedField(fields: InspectFields): boolean {
  const outcomes = Object.values(fields) as FieldOutcome<unknown>[];
  return outcomes.some((field) => field.state === 'failed' || field.state === 'denied');
}

function canonicalizeBestEffort(value: string): string | undefined {
  try {
    return parseCanonicalNodeId(value);
  } catch {
    return undefined;
  }
}

function canonicalizeUnknownNodeId(value: unknown): string | undefined {
  if (typeof value === 'string') return canonicalizeBestEffort(value);
  const text = customToString(value);
  return text === undefined ? undefined : canonicalizeBestEffort(text);
}

function namespaceIndexOf(nodeId: string): number {
  const match = /^ns=(\d+);/u.exec(nodeId);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function numericIdentifier(nodeId: string): number | undefined {
  // NodeIds are bounded before reaching this parser.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /(?:^ns=\d+;)?i=(\d+)$/u.exec(nodeId);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function dataTypeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (WELL_KNOWN_OPC_UA_DATA_TYPES[Number(value)] !== undefined)
    return WELL_KNOWN_OPC_UA_DATA_TYPES[Number(value)];
  const nodeId = canonicalizeBestEffort(value);
  const numeric = nodeId === undefined ? undefined : numericIdentifier(nodeId);
  return numeric === undefined ? value : WELL_KNOWN_OPC_UA_DATA_TYPES[numeric] ?? value;
}

function dataTypeNodeIdFromProtocol(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // NodeIds are bounded before reaching this parser.
  // eslint-disable-next-line security/detect-unsafe-regex
  if (/^(?:ns=\d+;)?i=\d+$/u.test(value)) return canonicalizeBestEffort(value);
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && WELL_KNOWN_OPC_UA_DATA_TYPES[numeric] !== undefined)
    return `ns=0;i=${String(numeric)}`;
  const id = Object.entries(WELL_KNOWN_OPC_UA_DATA_TYPES).find(([, name]) => name === value)?.[0];
  return id === undefined ? canonicalizeBestEffort(value) : `ns=0;i=${id}`;
}

function timestamps(value: ProtocolDataValue): {
  sourceTimestamp?: string;
  serverTimestamp?: string;
} {
  return {
    ...(value.sourceTimestamp === undefined ? {} : { sourceTimestamp: value.sourceTimestamp }),
    ...(value.serverTimestamp === undefined ? {} : { serverTimestamp: value.serverTimestamp }),
  };
}

function convertValue(
  value: unknown,
  dataType: string | undefined,
  arrayType: ProtocolDataValue['arrayType'],
  maximumArrayElements: number,
):
  | { ok: true; value: OpcUaJsonValue }
  | { ok: false; state: 'failed' | 'unsupported'; code: string; message: string } {
  const typeName = dataTypeName(dataType);
  if (arrayType === 'matrix')
    return {
      ok: false,
      state: 'unsupported',
      code: 'unsupported_value',
      message: 'OPC UA matrix values are unsupported.',
    };
  if (
    (typeName === 'Int64' || typeName === 'UInt64') &&
    arrayType !== 'array' &&
    isSafeInt64Pair(value)
  ) {
    const high = BigInt(value[0]);
    const low = BigInt(value[1]) & 0xffffffffn;
    const integer = (high << 32n) + low;
    return {
      ok: true,
      value: {
        type: typeName === 'UInt64' ? 'UInt64' : 'Int64',
        value: integer.toString(10),
      },
    };
  }
  if (Array.isArray(value)) {
    if (value.length > maximumArrayElements)
      return {
        ok: false,
        state: 'failed',
        code: 'response_limit_exceeded',
        message: 'The OPC UA array exceeds the configured element limit.',
      };
    const converted: OpcUaJsonScalar[] = [];
    for (const item of value) {
      const one = convertScalar(item, dataType);
      if (!one.ok) return one;
      converted.push(one.value);
    }
    return { ok: true, value: converted };
  }
  const scalar = convertScalar(value, dataType);
  return scalar.ok ? { ok: true, value: scalar.value } : scalar;
}

function convertScalar(
  value: unknown,
  dataType?: string,
):
  | { ok: true; value: OpcUaJsonScalar }
  | { ok: false; state: 'failed' | 'unsupported'; code: string; message: string } {
  const typeName = dataTypeName(dataType);
  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'string') {
    if (typeName === 'Int64' || typeName === 'UInt64')
      return {
        ok: true,
        value: { type: typeName === 'UInt64' ? 'UInt64' : 'Int64', value },
      };
    if (typeName === 'DateTime') return { ok: true, value: { type: 'DateTime', value } };
    const canonicalType =
      typeName === 'Guid'
        ? 'Guid'
        : typeName === 'NodeId'
          ? 'NodeId'
          : typeName === 'ExpandedNodeId'
            ? 'ExpandedNodeId'
            : typeName === 'QualifiedName'
              ? 'QualifiedName'
              : undefined;
    if (canonicalType !== undefined) return { ok: true, value: { type: canonicalType, value } };
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return {
        ok: true,
        value: {
          type: 'FloatSpecial',
          value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity',
        },
      };
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      return {
        ok: false,
        state: 'unsupported',
        code: 'unsafe_integer',
        message: 'The OPC UA integer cannot be represented safely as a JSON number.',
      };
    if (typeName === 'Int64' || typeName === 'UInt64')
      return {
        ok: true,
        value: { type: typeName === 'UInt64' ? 'UInt64' : 'Int64', value: String(value) },
      };
    return { ok: true, value };
  }
  if (typeof value === 'bigint')
    return {
      ok: true,
      value: {
        type: typeName === 'UInt64' ? 'UInt64' : 'Int64',
        value: value.toString(10),
      },
    };
  if (value instanceof Date)
    return { ok: true, value: { type: 'DateTime', value: value.toISOString() } };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return {
      ok: true,
      value: { type: 'ByteString', value: Buffer.from(value).toString('base64') },
    };
  const localized = mapLocalizedText(value);
  if (localized !== undefined)
    return { ok: true, value: { type: 'LocalizedText', value: localized } };
  const qualified = asQualifiedName(value);
  if (qualified !== undefined)
    return {
      ok: true,
      value: {
        type: 'QualifiedName',
        value: `${String(qualified.namespaceIndex)}:${qualified.name}`,
      },
    };
  const text = customToString(value);
  if (text !== undefined && text !== '[object Object]') {
    const type =
      typeName === 'Guid'
        ? 'Guid'
        : typeName === 'ExpandedNodeId'
          ? 'ExpandedNodeId'
          : typeName === 'NodeId'
            ? 'NodeId'
            : undefined;
    if (type !== undefined) return { ok: true, value: { type, value: text } };
  }
  return {
    ok: false,
    state: 'unsupported',
    code: 'unsupported_value',
    message: 'The OPC UA value representation is unsupported.',
  };
}

function propertyOutcome<T>(
  property: PropertyRead | undefined,
  code: string,
  decode: (value: unknown) => T | undefined,
  maximumArrayElements?: number,
): FieldOutcome<T> {
  if (property === undefined) return { state: 'not_present' };
  const { value, source } = property;
  const withSource = <V>(outcome: FieldOutcome<V>): FieldOutcome<V> => ({ ...outcome, source });
  if (value.statusCode.includes('AttributeIdInvalid'))
    return withSource({ state: 'not_present', statusCode: value.statusCode });
  if (value.quality === 'bad')
    return withSource(fieldFromDataValue(value, code, 'The diagnostic property could not be read.'));
  if (Array.isArray(value.value) && maximumArrayElements !== undefined && value.value.length > maximumArrayElements)
    return withSource(
      fieldFailed('response_limit_exceeded', 'The diagnostic property exceeds the array element limit.', value.statusCode),
    );
  const decoded = decode(value.value);
  return decoded === undefined
    ? withSource(
        fieldFailed(
          code,
          'The diagnostic property has an unsupported representation.',
          value.statusCode,
        ),
      )
    : fieldPresent(decoded, value.statusCode, source);
}

function diagnosticOutcome<T>(
  outcomes: Map<string, FieldOutcome<unknown>>,
  name: string,
): FieldOutcome<T> {
  return (outcomes.get(name) as FieldOutcome<T> | undefined) ?? { state: 'not_present' };
}

function isSafeInt64Pair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item: unknown) => typeof item === 'number' && Number.isSafeInteger(item))
  );
}

function decodeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decodeDateTime(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : undefined;
}

function decodeRange(value: unknown): { low: number; high: number } | undefined {
  if (
    !isRecord(value) ||
    typeof value['low'] !== 'number' ||
    typeof value['high'] !== 'number' ||
    !isSafeFiniteNumber(value['low']) ||
    !isSafeFiniteNumber(value['high'])
  )
    return undefined;
  return { low: value['low'], high: value['high'] };
}

function isSafeFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function decodeEngineeringUnits(value: unknown): EngineeringUnitValue | undefined {
  if (
    !isRecord(value) ||
    typeof value['namespaceUri'] !== 'string' ||
    typeof value['unitId'] !== 'number' ||
    !Number.isSafeInteger(value['unitId'])
  )
    return undefined;
  const displayName = mapLocalizedText(value['displayName']);
  const description = mapLocalizedText(value['description']);
  if (displayName === undefined || description === undefined) return undefined;
  return { namespaceUri: value['namespaceUri'], unitId: value['unitId'], displayName, description };
}

function decodeLocalizedTextArray(value: unknown): LocalizedTextValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(mapLocalizedText);
  return result.every((item): item is LocalizedTextValue => item !== undefined)
    ? result
    : undefined;
}

function decodeEnumValues(value: unknown): EnumValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map((item) => {
    if (!isRecord(item)) return undefined;
    const displayName = mapLocalizedText(item['displayName']);
    const description = mapLocalizedText(item['description']);
    if (displayName === undefined || description === undefined) return undefined;
    const raw = item['value'];
    if (typeof raw === 'bigint')
      return { value: { int64: raw.toString(10) }, displayName, description };
    if (typeof raw === 'number' && Number.isSafeInteger(raw))
      return { value: { int64: String(raw) }, displayName, description };
    const text = customToString(raw);
    if (text !== undefined) return { value: { int64: text }, displayName, description };
    return undefined;
  });
  return result.every((item): item is EnumValue => item !== undefined) ? result : undefined;
}

function metadataField<T>(
  result: ProtocolResult<ProtocolDataValue[]>,
  requests: { name: string; request: { nodeId: string; attributeId: number } }[],
  name: string,
  decoder: (value: unknown) => T | undefined,
): FieldOutcome<T> {
  const index = requests.findIndex((request) => request.name === name);
  if (index < 0) return { state: 'not_present' };
  if (!result.ok)
    return fieldFailed(result.error.code, result.error.message, result.error.statusCode);
  return fieldFromDataValue(
    result.value[index],
    'metadata_unavailable',
    'Namespace metadata field could not be read.',
    (raw) => {
      const decoded = decoder(raw);
      return decoded === undefined
        ? fieldFailed('metadata_type_mismatch', 'Namespace metadata field has an unexpected type.')
        : fieldPresent(decoded);
    },
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedPositive(value: number | undefined, fallback: number, hardCap: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, hardCap);
}

function boundedNonNegative(value: number | undefined, fallback: number, hardCap: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, hardCap);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function sanitizeMessage(value: string): string {
  return value.split('\n')[0]?.slice(0, 500) ?? 'The OPC UA operation failed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function customToString(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.toString !== 'function') return undefined;
  // SDK identifiers expose their canonical representation through a custom toString.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return value.toString();
}

function getStandardNames(): Map<number, string> {
  if (standardNames !== undefined) return standardNames;
  standardNames = new Map<number, string>([
    ...Object.entries(WELL_KNOWN_OPC_UA_DATA_TYPES).map(
      ([id, name]) => [Number(id), name] as const,
    ),
    [31, 'References'],
    [32, 'NonHierarchicalReferences'],
    [33, 'HierarchicalReferences'],
    [34, 'HasChild'],
    [35, 'Organizes'],
    [36, 'HasEventSource'],
    [37, 'HasModellingRule'],
    [38, 'HasEncoding'],
    [39, 'HasDescription'],
    [40, 'HasTypeDefinition'],
    [41, 'GeneratesEvent'],
    [44, 'Aggregates'],
    [45, 'HasSubtype'],
    [46, 'HasProperty'],
    [47, 'HasComponent'],
    [48, 'HasNotifier'],
    [49, 'HasOrderedComponent'],
    [58, 'BaseObjectType'],
    [61, 'FolderType'],
    [62, 'BaseVariableType'],
    [63, 'BaseDataVariableType'],
    [68, 'PropertyType'],
    [11616, 'NamespaceMetadataType'],
    [11617, 'NamespaceUri'],
    [11618, 'NamespaceVersion'],
    [11619, 'NamespacePublicationDate'],
    [11715, 'Namespaces'],
    [2253, 'Server'],
    [2255, 'Server_NamespaceArray'],
  ]);
  return standardNames;
}
