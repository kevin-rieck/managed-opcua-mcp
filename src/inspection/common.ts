export const MAX_NODE_ID_LENGTH = 4_096;

export type NodeSelector =
  | { nodeId: string; label?: never }
  | { label: string; nodeId?: never };

export type NodeSelectorValidation =
  | { ok: true; selector: NodeSelector }
  | { ok: false; code: NodeSelectorValidationCode; message: string };

export type NodeSelectorValidationCode =
  | 'missing_selector'
  | 'conflicting_selector'
  | 'invalid_node_id'
  | 'invalid_label';

/**
 * Validates the public selector boundary before any OPC UA operation.
 *
 * NodeId syntax is parsed before protocol-adapter use. The adapter canonicalizes it
 * and resolves its namespace URI against the active OPC UA Server session.
 */
export function validateNodeSelector(input: unknown): NodeSelectorValidation {
  if (!isRecord(input)) return failure('missing_selector', 'Provide a NodeId or Read Entry Point label.');

  const hasNodeId = input['nodeId'] !== undefined;
  const hasLabel = input['label'] !== undefined;

  if (hasNodeId && hasLabel) {
    return failure('conflicting_selector', 'Provide either a NodeId or Read Entry Point label, not both.');
  }
  if (!hasNodeId && !hasLabel) {
    return failure('missing_selector', 'Provide a NodeId or Read Entry Point label.');
  }

  if (hasNodeId) {
    const nodeId = input['nodeId'];
    if (
      typeof nodeId !== 'string' ||
      nodeId.length === 0 ||
      nodeId.length > MAX_NODE_ID_LENGTH ||
      !isParsableNodeId(nodeId)
    ) {
      return failure(
        'invalid_node_id',
        `NodeId must be a valid OPC UA NodeId with at most ${String(MAX_NODE_ID_LENGTH)} characters.`,
      );
    }
    return { ok: true, selector: { nodeId } };
  }

  const label = input['label'];
  if (typeof label !== 'string' || label.length === 0) {
    return failure('invalid_label', 'Read Entry Point label must be a non-empty string.');
  }
  return { ok: true, selector: { label } };
}

function failure(code: NodeSelectorValidationCode, message: string): NodeSelectorValidation {
  return { ok: false, code, message };
}

function isParsableNodeId(nodeId: string): boolean {
  let identifier = nodeId;
  if (identifier.startsWith('ns=')) {
    const separator = identifier.indexOf(';');
    if (separator === -1 || !isUnsignedInteger(identifier.slice(3, separator), 65_535)) {
      return false;
    }
    identifier = identifier.slice(separator + 1);
  }

  const identifierType = identifier.slice(0, 2);
  const value = identifier.slice(2);
  switch (identifierType) {
    case 'i=':
      return isUnsignedInteger(value, 4_294_967_295);
    case 's=':
      return true;
    case 'g=':
      return isGuid(value);
    case 'b=':
      return isBase64(value);
    default:
      return false;
  }
}

function isUnsignedInteger(value: string, maximum: number): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (character < '0' || character > '9') return false;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum;
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;

  const firstPadding = value.indexOf('=');
  const contentLength = firstPadding === -1 ? value.length : firstPadding;
  const paddingLength = value.length - contentLength;
  if (paddingLength > 2) return false;

  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Character(value[index] ?? '')) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value[index] !== '=') return false;
  }
  return true;
}

function isBase64Character(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') ||
    character === '+' ||
    character === '/'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
