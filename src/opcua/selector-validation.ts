/* eslint-disable security/detect-unsafe-regex -- NodeId text is bounded to 4,096 scalars before grammar validation. */
import { createRequire } from 'node:module';
import type { InspectionError, NodeSelector } from './inspection-contracts.js';

export type NodeIdParser = (value: string) => string;

export type SelectorValidation =
  | {
      ok: true;
      selector: NodeSelector;
      canonicalNodeId: string;
      resolvedFromLabel?: string;
    }
  | { ok: false; error: InspectionError };

export interface CorrelatedSelectorValidation {
  index: number;
  selector: NodeSelector;
  validation: SelectorValidation;
}

export type SelectorBatchValidation =
  { ok: true; items: CorrelatedSelectorValidation[] } | { ok: false; error: InspectionError };

export interface SelectorBatchValidationOptions {
  maximumBatchSize: number;
  parseNodeId?: NodeIdParser;
  resolveLabel?: (label: string) => string | undefined;
}

interface NodeOpcUaNodeIdModule {
  coerceNodeId(value: string): { toString(): string };
}

const require = createRequire(import.meta.url);
const MAX_NODE_ID_SCALARS = 4_096;
let nodeOpcUa: NodeOpcUaNodeIdModule | undefined;

export function validateNodeSelector(
  selector: NodeSelector,
  parseNodeId: NodeIdParser = parseCanonicalNodeId,
  resolveLabel?: (label: string) => string | undefined,
): SelectorValidation {
  const input = selector as { nodeId?: string; label?: string };
  const hasNodeId = typeof input.nodeId === 'string';
  const hasLabel = typeof input.label === 'string';
  if (hasNodeId === hasLabel) {
    return invalidSelector('A selector must contain exactly one of nodeId or label.');
  }

  if (hasLabel) {
    const label = input.label?.trim() ?? '';
    if (label.length === 0) return invalidSelector('The selector label must not be empty.');
    if (resolveLabel === undefined) {
      return invalidSelector('A Read Entry Point label resolver is required for label selectors.');
    }
    const resolvedNodeId = resolveLabel(label);
    if (resolvedNodeId === undefined) {
      return invalidSelector('The selector label is not a configured Read Entry Point.');
    }
    const validation = validateNodeId(resolvedNodeId, parseNodeId);
    if (!validation.ok) return validation;
    return { ...validation, selector, resolvedFromLabel: label };
  }

  const nodeId = input.nodeId ?? '';
  const validation = validateNodeId(nodeId, parseNodeId);
  return validation.ok ? { ...validation, selector } : validation;
}

export function validateNodeSelectorBatch(
  selectors: NodeSelector[],
  options: SelectorBatchValidationOptions,
): SelectorBatchValidation {
  if (selectors.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: 'At least one selector is required.' },
    };
  }
  if (selectors.length > options.maximumBatchSize) {
    return {
      ok: false,
      error: {
        code: 'request_limit_exceeded',
        message: `The selector batch exceeds the maximum of ${String(options.maximumBatchSize)} items.`,
      },
    };
  }

  const parser = options.parseNodeId ?? parseCanonicalNodeId;
  return {
    ok: true,
    items: selectors.map((selector, index) => ({
      index,
      selector,
      validation: validateNodeSelector(selector, parser, options.resolveLabel),
    })),
  };
}

function validateNodeId(nodeId: string, parseNodeId: NodeIdParser): SelectorValidation {
  if (nodeId.length === 0) return invalidSelector('The selector NodeId must not be empty.');
  // The specification requires Unicode scalar values (code points), not grapheme clusters.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  if ([...nodeId].length > MAX_NODE_ID_SCALARS) {
    return invalidSelector('The selector NodeId exceeds 4096 Unicode scalar values.');
  }
  if (!isNodeIdText(nodeId)) return invalidSelector('The selector NodeId is invalid.');

  try {
    return { ok: true, selector: { nodeId }, canonicalNodeId: parseNodeId(nodeId) };
  } catch {
    return invalidSelector('The selector NodeId is invalid.');
  }
}

function isNodeIdText(value: string): boolean {
  const identifier = value.replace(/^ns=\d+;/u, '');
  return (
    /^i=\d+$/u.test(identifier) ||
    /^s=.*$/su.test(identifier) ||
    /^g=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identifier) ||
    /^b=(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(identifier)
  );
}

export function parseCanonicalNodeId(value: string): string {
  nodeOpcUa ??= require('node-opcua') as NodeOpcUaNodeIdModule;
  return nodeOpcUa.coerceNodeId(value).toString();
}

function invalidSelector(message: string): SelectorValidation {
  return { ok: false, error: { code: 'invalid_selector', message } };
}
