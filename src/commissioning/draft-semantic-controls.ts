import type {
  CommissioningDiscoveryResult,
  CommissioningNode,
  DraftEnumValueHint,
  DraftSemanticControlCandidate,
  EnumValueFact,
  Evidence,
  SemanticControlCandidateReason,
  WritableButNotSuggestedNode,
  WritableNotSuggestedReason,
} from './discovery.js';

/**
 * Derive review-only Semantic Control suggestions from sanitized discovery facts.
 * The returned candidates are deliberately not executable Control Catalog items.
 */
export function generateDraftSemanticControlCandidates(
  discovery: CommissioningDiscoveryResult,
): CommissioningDiscoveryResult {
  const candidates: DraftSemanticControlCandidate[] = [];
  const rejected: WritableButNotSuggestedNode[] = [];
  const seenNodeIds = new Set<string>();
  const usedNames = new Map<string, number>();
  const orderedNodes = [...discovery.nodes].sort((left, right) =>
    left.identity.nodeId.localeCompare(right.identity.nodeId),
  );

  for (const node of orderedNodes) {
    if (seenNodeIds.has(node.identity.nodeId)) continue;
    seenNodeIds.add(node.identity.nodeId);
    if (node.access?.writable?.value !== true) continue;

    const rejectionReasons = ineligibilityReasons(node);
    if (rejectionReasons.length > 0) {
      rejected.push({
        nodeId: node.identity.nodeId,
        ...(node.identity.displayName === undefined
          ? {}
          : { displayName: node.identity.displayName }),
        ...(node.dataType === undefined ? {} : { dataType: node.dataType.opcuaName }),
        reasons: rejectionReasons,
        evidence: candidateEvidence(node),
      });
      continue;
    }

    const path = identityParts(node);
    const mappedType = node.dataType?.mappedType;
    if (mappedType === undefined) continue;
    const engineeringUnits = node.dataAccess?.engineeringUnits;
    const normalRange = node.dataAccess?.euRange ?? node.dataAccess?.instrumentRange;
    const enumValues = suggestedEnumValues(node);
    const baseName = `set_${path.map(toSnakeCase).filter(Boolean).join('_')}`;
    const occurrence = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, occurrence);
    const reasons: SemanticControlCandidateReason[] = [
      'scalar_supported_data_type',
      'session_writable',
      'named_variable',
    ];
    if (engineeringUnits !== undefined) reasons.push('has_engineering_units');
    if (normalRange !== undefined) reasons.push('has_normal_range');
    if (enumValues !== undefined) reasons.push('has_enum_values');
    reasons.push('operator_safety_fields_required');

    candidates.push({
      nodeId: node.identity.nodeId,
      suggestedName: occurrence === 1 ? baseName : `${baseName}_${String(occurrence)}`,
      ...(path.length < 2
        ? {}
        : {
            suggestedGroup: path
              .slice(0, -1)
              .map((part) => toSnakeIdentifier(part, 'group'))
              .join('/'),
          }),
      description: suggestedDescription(node, path),
      dataType: mappedType,
      ...(engineeringUnits?.value.displayName === undefined
        ? {}
        : { unit: engineeringUnits.value.displayName }),
      ...(normalRange === undefined ? {} : { normalRange: normalRange.value }),
      ...(enumValues === undefined ? {} : { enumValues }),
      draftState: 'inactive_review_required',
      eligibility: 'needs_operator_review',
      reasons,
      evidence: candidateEvidence(node),
    });
  }

  const rejectionWarnings = rejected.map((node) => ({
    code: 'writable_not_suggested' as const,
    area: node.nodeId,
    message: `Writable Node was not suggested: ${node.reasons.join(', ')}.`,
    evidence: node.evidence,
  }));
  const rangeWarnings = candidates
    .filter((candidate) => candidate.normalRange !== undefined)
    .map((candidate) => ({
      code: 'range_requires_operator_confirmation' as const,
      area: candidate.nodeId,
      message: 'Discovered range is a draft hint and requires Operator confirmation.',
      evidence: candidate.evidence,
    }));

  return {
    ...discovery,
    draftSemanticControls: candidates,
    writableButNotSuggested: rejected,
    findings: {
      blocking: discovery.findings.blocking,
      warnings: [...discovery.findings.warnings, ...rejectionWarnings, ...rangeWarnings].sort(
        (left, right) => left.area.localeCompare(right.area) || left.code.localeCompare(right.code),
      ),
    },
  };
}

function ineligibilityReasons(node: CommissioningNode): WritableNotSuggestedReason[] {
  const reasons: WritableNotSuggestedReason[] = [];
  if (node.nodeClass?.value !== 'Variable') {
    reasons.push(
      node.nodeClass?.value === 'Method' ? 'method_calls_out_of_scope' : 'operator_review_required',
    );
  }
  if (node.valueShape !== undefined && node.valueShape.kind !== 'scalar') {
    reasons.push('array_value_shape');
  }
  if (node.dataType === undefined) reasons.push('missing_data_type');
  else if (node.dataType.mappedType === undefined) reasons.push('unsupported_data_type');
  if (identityParts(node).length === 0) reasons.push('missing_identity_context');
  return reasons;
}

function identityParts(node: CommissioningNode): string[] {
  const path = node.identity.path?.filter((part) => toSnakeCase(part).length > 0) ?? [];
  if (path.length > 0) return path;
  const name = node.identity.displayName ?? node.identity.browseName ?? node.description?.value;
  return name === undefined ? [] : [name];
}

function suggestedDescription(node: CommissioningNode, path: string[]): string {
  return (
    node.description?.value ??
    node.identity.displayName ??
    node.identity.browseName ??
    path.join(' / ')
  );
}

function suggestedEnumValues(node: CommissioningNode): DraftEnumValueHint[] | undefined {
  if (node.dataType?.mappedType === 'String') return undefined;
  const enumValues = node.dataAccess?.enumValues?.value;
  if (enumValues !== undefined && enumValues.length > 0) return addEnumLabels(enumValues);
  const enumStrings = node.dataAccess?.enumStrings?.value;
  if (enumStrings === undefined || enumStrings.length === 0) return undefined;
  return addEnumLabels(enumStrings.map((displayName, value) => ({ value, displayName })));
}

function addEnumLabels(values: EnumValueFact[]): DraftEnumValueHint[] {
  const usedLabels = new Map<string, number>();
  return values.map((value) => {
    const baseLabel = toSnakeIdentifier(value.displayName ?? String(value.value), 'value');
    const occurrence = (usedLabels.get(baseLabel) ?? 0) + 1;
    usedLabels.set(baseLabel, occurrence);
    return {
      ...value,
      suggestedLabel: occurrence === 1 ? baseLabel : `${baseLabel}_${String(occurrence)}`,
    };
  });
}

function candidateEvidence(node: CommissioningNode): Evidence<unknown>[] {
  const evidenceItems: Evidence<unknown>[] = [];
  const items = [
    node.nodeClass,
    node.valueShape?.evidence,
    node.dataType?.evidence,
    node.access?.writable,
    node.access?.userAccess,
    node.dataAccess?.engineeringUnits,
    node.dataAccess?.euRange,
    node.dataAccess?.instrumentRange,
    node.dataAccess?.enumStrings,
    node.dataAccess?.enumValues,
  ];
  for (const item of items) {
    if (item !== undefined) evidenceItems.push(item);
  }
  return evidenceItems;
}

function toSnakeIdentifier(value: string, prefix: string): string {
  const snake = toSnakeCase(value);
  if (/^[a-z]/u.test(snake)) return snake;
  return snake.length === 0 ? prefix : `${prefix}_${snake}`;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/^\d+:/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}
