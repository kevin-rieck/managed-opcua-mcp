import YAML from 'yaml';
import type {
  CommissioningDiscoveryResult,
  CommissioningFinding,
  CommissioningMetadataField,
  DraftSemanticControlCandidate,
  Evidence,
} from './discovery.js';

export interface CommissioningMarkdownReportOptions {
  endpointUrl?: string;
  authMode?: 'anonymous' | 'usernamePassword';
  generatedConfigPath?: string;
  redactEndpoint?: boolean;
}

/** Render sanitized commissioning facts into a deterministic Operator review report. */
export function generateCommissioningMarkdownReport(
  discovery: CommissioningDiscoveryResult,
  options: CommissioningMarkdownReportOptions = {},
): string {
  const blocking = sortedFindings(discovery.findings.blocking);
  const warnings = sortedFindings(discovery.findings.warnings);
  const recommendation = blocking.length > 0 ? 'not_ready_to_serve' : 'operator_review_required';
  const endpointIsRedacted = options.redactEndpoint !== false;
  const endpoint = endpointIsRedacted
    ? '[redacted]'
    : options.endpointUrl === undefined
      ? 'not provided'
      : sanitizeEndpoint(options.endpointUrl);
  const lines: string[] = [
    '# OPC UA MCP Commissioning Report',
    '',
    `Generated: ${inline(discovery.generatedAt)}`,
    `Report mode: \`${endpointIsRedacted ? 'redacted' : 'topology-visible'}\``,
    'Commissioning state: `draft`',
    `Commissioning recommendation: \`${recommendation}\``,
    '',
    '## 1. Summary',
    '',
    '| Item | Result |',
    '| --- | --- |',
    row('OPC UA endpoint', endpoint),
    row('Auth mode', options.authMode ?? 'not provided'),
    row('Discovery roots requested', discovery.coverage.requestedRoots),
    row('Discovery roots succeeded', discovery.coverage.succeededRoots),
    row(
      'Nodes visited',
      `${String(discovery.coverage.nodesVisited)} / max ${String(discovery.coverage.maxNodes)}`,
    ),
    row(
      'Discovery depth',
      `${String(discovery.coverage.depthReached)} / requested ${String(discovery.coverage.depthRequested)}`,
    ),
    row('Suggested Read Entry Points', discovery.suggestedReadEntryPoints.length),
    row('Draft Semantic Control candidates', discovery.draftSemanticControls.length),
    row('Writable but not suggested', discovery.writableButNotSuggested.length),
    row('Blocking errors', blocking.length),
    row('Warnings', warnings.length),
    row('Generated config', options.generatedConfigPath ?? 'not generated'),
    '',
    '**Draft status:** This report does not commission a config. Do not use generated draft Semantic Controls with `opcua-mcp serve` until blocking errors are resolved, Operator decisions are completed, and online diagnostics pass.',
    '',
    '## 2. Blocking errors',
    '',
    'These must be resolved before the config can be considered ready to serve.',
    '',
    '| Code | Area | Message | Evidence |',
    '| --- | --- | --- | --- |',
    ...findingRows(blocking, true),
    '',
    '## 3. Warnings',
    '',
    'Warnings may be acceptable, but require Operator review.',
    '',
    '| Code | Area | Message |',
    '| --- | --- | --- |',
    ...findingRows(warnings, false),
    '',
    '## 4. Required Operator decisions',
    '',
    'Complete applicable decisions before promoting draft candidates into executable `controls.items`.',
    '',
    '| Code | Decision | Applies to |',
    '| --- | --- | --- |',
    ...decisionRows(discovery),
    '',
    '## 5. Suggested Read Entry Points',
    '',
    'These are navigation aids only. They are not authorization boundaries; the OPC UA Server enforces read access.',
    '',
    '| Suggested label | NodeId | Display name | Reason | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...readEntryPointRows(discovery),
    '',
    '## 6. Draft Semantic Control candidates',
    '',
    'These are **not executable**. Every candidate is inactive and requires Operator review and explicit promotion into the Control Catalog.',
    '',
    ...candidateSections(discovery),
    '## 7. Writable but not suggested',
    '',
    'These Nodes appeared writable but were not suggested as draft Semantic Controls. OPC UA Server authorization remains authoritative.',
    '',
    '| NodeId | Display name | Data type | Reasons | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...writableNotSuggestedRows(discovery),
    '',
    '## 8. Discovery coverage and evidence',
    '',
    '| Root | Status | Nodes visited | Depth reached | Notes |',
    '| --- | --- | ---: | ---: | --- |',
    ...rootRows(discovery),
    '',
    'Metadata evidence summary:',
    '',
    '| Metadata | Succeeded | Failed | Not present |',
    '| --- | ---: | ---: | ---: |',
    ...metadataRows(discovery),
    '',
    '## 9. Redaction and sensitive-data note',
    '',
    `This report was generated in ${endpointIsRedacted ? 'redacted' : 'topology-visible'} mode.`,
    '',
    '- Passwords, tokens, usernames, certificate private-key material, and environment secret references are not included.',
    `- Endpoint URL is ${endpointIsRedacted ? 'redacted because it can reveal plant/network topology' : 'shown without embedded credentials at the Operator’s request'}.`,
    '- Evidence is summarized by sanitized source and OPC UA status; current OPC UA values are not included.',
    '- Discovery does not change OPC UA Server authorization and performs no Control Operation.',
    '',
  ];

  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n')}\n`;
}

function findingRows(findings: CommissioningFinding[], includeEvidence: boolean): string[] {
  if (findings.length === 0)
    return [includeEvidence ? '| _None_ | — | — | — |' : '| _None_ | — | — |'];
  return findings.map((finding) =>
    includeEvidence
      ? `| \`${cell(finding.code)}\` | ${cell(finding.area)} | ${cell(finding.message)} | ${cell(evidenceSummary(finding.evidence))} |`
      : `| \`${cell(finding.code)}\` | ${cell(finding.area)} | ${cell(finding.message)} |`,
  );
}

function decisionRows(discovery: CommissioningDiscoveryResult): string[] {
  const decisions: [string, string, string][] = [];
  if (discovery.suggestedReadEntryPoints.length > 0) {
    decisions.push([
      'select_read_entry_points',
      'Choose final Read Entry Points and labels.',
      'Suggested Read Entry Points',
    ]);
  }
  if (discovery.roots.some((root) => root.status !== 'succeeded')) {
    decisions.push([
      'resolve_incomplete_roots',
      'Fix OPC UA Server authorization/availability or accept the incomplete discovery scope.',
      'Partial or failed discovery roots',
    ]);
  }
  if (discovery.draftSemanticControls.length > 0) {
    decisions.push(
      [
        'confirm_control_identity',
        'Choose each final Semantic Control name and confirm its description and target Node.',
        'Each draft Semantic Control candidate',
      ],
      [
        'assign_control_risk',
        'Assign Operator-owned Risk Level and Risk Note.',
        'Each draft Semantic Control candidate',
      ],
      [
        'confirm_control_constraints',
        'Confirm bounds, units, labels, and allowed values; discovered metadata is advisory.',
        'Each draft Semantic Control candidate',
      ],
      [
        'promote_or_reject_control',
        'Explicitly promote a reviewed candidate into the Control Catalog or reject it.',
        'Each draft Semantic Control candidate',
      ],
    );
  }
  if (discovery.writableButNotSuggested.length > 0) {
    decisions.push([
      'review_unsuggested_writable_nodes',
      'Confirm that writable Nodes omitted from suggestions remain outside the Control Catalog.',
      'Writable but not suggested',
    ]);
  }
  if (discovery.findings.warnings.length > 0) {
    decisions.push([
      'accept_or_resolve_warnings',
      'Resolve warnings or record that they are acceptable for commissioning.',
      'Report warnings',
    ]);
  }
  if (decisions.length === 0) return ['| _None identified_ | — | — |'];
  return decisions.map(
    ([code, decision, applies]) => `| \`${code}\` | ${cell(decision)} | ${cell(applies)} |`,
  );
}

function readEntryPointRows(discovery: CommissioningDiscoveryResult): string[] {
  const suggestions = [...discovery.suggestedReadEntryPoints].sort(
    (left, right) =>
      left.suggestedLabel.localeCompare(right.suggestedLabel) ||
      left.nodeId.localeCompare(right.nodeId),
  );
  if (suggestions.length === 0) return ['| _None_ | — | — | — | — |'];
  return suggestions.map(
    (suggestion) =>
      `| \`${cell(suggestion.suggestedLabel)}\` | \`${cell(suggestion.nodeId)}\` | ${cell(suggestion.displayName ?? '—')} | \`${cell(suggestion.reason)}\` | ${cell(evidenceSummary(suggestion.evidence))} |`,
  );
}

function candidateSections(discovery: CommissioningDiscoveryResult): string[] {
  const candidates = [...discovery.draftSemanticControls].sort(
    (left, right) =>
      left.suggestedName.localeCompare(right.suggestedName) ||
      left.nodeId.localeCompare(right.nodeId),
  );
  if (candidates.length === 0) return ['_No draft candidates were generated._', ''];
  return candidates.flatMap((candidate) => [
    `### Candidate: \`${inline(candidate.suggestedName)}\``,
    '',
    '| Field | Draft value | Operator action |',
    '| --- | --- | --- |',
    row3('State', candidate.draftState, 'Review; candidate is inactive'),
    row3('NodeId', candidate.nodeId, 'Confirm target and OPC UA Server authorization'),
    row3('Data type', candidate.dataType, 'Confirm'),
    row3('Description', candidate.description ?? 'missing', 'Confirm/edit'),
    row3('Unit', candidate.unit ?? 'missing', 'Confirm where applicable'),
    row3(
      'Range',
      candidate.normalRange === undefined
        ? 'missing'
        : `${String(candidate.normalRange.low)} … ${String(candidate.normalRange.high)}`,
      'Confirm as process bounds',
    ),
    row3('Evidence', evidenceSummary(candidate.evidence), 'Review advisory metadata'),
    row3('Risk Level / Risk Note', 'missing', 'Required Operator input'),
    '',
    'Suggested YAML fragment:',
    '',
    '    # Draft only — inactive and requires Operator review',
    ...draftYaml(candidate)
      .trimEnd()
      .split('\n')
      .map((line) => `    ${line}`),
    '',
  ]);
}

function draftYaml(candidate: DraftSemanticControlCandidate): string {
  const item: Record<string, unknown> = {
    name: candidate.suggestedName,
    ...(candidate.suggestedGroup === undefined ? {} : { group: candidate.suggestedGroup }),
    description: candidate.description ?? 'TODO',
    nodeId: candidate.nodeId,
    dataType: candidate.dataType,
  };
  if (candidate.dataType === 'Boolean') {
    item['falseLabel'] = 'TODO';
    item['trueLabel'] = 'TODO';
  } else if (candidate.enumValues !== undefined || candidate.dataType === 'String') {
    item['allowedValues'] = candidate.enumValues?.map(({ suggestedLabel, value }) => ({
      label: suggestedLabel,
      value,
    })) ?? [{ label: 'TODO', value: 'TODO' }];
  } else {
    item['unit'] = candidate.unit ?? 'TODO';
    item['min'] = candidate.normalRange?.low ?? 'TODO';
    item['max'] = candidate.normalRange?.high ?? 'TODO';
  }
  item['riskLevel'] = 'TODO';
  item['riskNote'] = 'TODO';
  return YAML.stringify(redactUnknown([item]), { lineWidth: 0 });
}

function writableNotSuggestedRows(discovery: CommissioningDiscoveryResult): string[] {
  const nodes = [...discovery.writableButNotSuggested].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
  if (nodes.length === 0) return ['| _None_ | — | — | — | — |'];
  return nodes.map(
    (node) =>
      `| \`${cell(node.nodeId)}\` | ${cell(node.displayName ?? '—')} | \`${cell(node.dataType ?? 'unknown')}\` | ${cell([...node.reasons].sort().join(', '))} | ${cell(evidenceSummary(node.evidence))} |`,
  );
}

function rootRows(discovery: CommissioningDiscoveryResult): string[] {
  const roots = [...discovery.roots].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (roots.length === 0) return ['| _None_ | — | 0 | 0 | — |'];
  return roots.map(
    (root) =>
      `| \`${cell(root.nodeId)}\` | \`${root.status}\` | ${String(root.nodesVisited)} | ${String(root.depthReached)} | ${cell(root.statusDetail === undefined ? '—' : `${root.statusDetail.severity}:${root.statusDetail.code}`)} |`,
  );
}

function metadataRows(discovery: CommissioningDiscoveryResult): string[] {
  const entries = Object.entries(discovery.coverage.fields).sort(([left], [right]) =>
    left.localeCompare(right),
  ) as [
    CommissioningMetadataField,
    NonNullable<(typeof discovery.coverage.fields)[CommissioningMetadataField]>,
  ][];
  if (entries.length === 0) return ['| _No metadata coverage recorded_ | 0 | 0 | 0 |'];
  return entries.map(
    ([field, coverage]) =>
      `| \`${field}\` | ${String(coverage.succeeded)} | ${String(coverage.failed)} | ${String(coverage.notPresent)} |`,
  );
}

function sortedFindings(findings: CommissioningFinding[]): CommissioningFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.area.localeCompare(right.area) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

function evidenceSummary(evidence: Evidence<unknown>[] | undefined): string {
  if (evidence === undefined || evidence.length === 0) return '—';
  return [
    ...new Set(
      evidence.map((item) => `${item.source}:${item.status.severity}:${item.status.code}`),
    ),
  ]
    .sort()
    .join(', ');
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    return redactText(parsed.toString());
  } catch {
    return '[redacted-invalid-endpoint]';
  }
}

function row(label: string, value: string | number): string {
  return `| ${cell(label)} | ${value === '[redacted]' ? '`[redacted]`' : cell(String(value))} |`;
}

function row3(field: string, value: string, action: string): string {
  return `| ${cell(field)} | ${cell(value)} | ${cell(action)} |`;
}

function inline(value: string): string {
  return redactText(value).replace(/[`\r\n]/gu, ' ');
}

function cell(value: string): string {
  return inline(value).replace(/\|/gu, '\\|');
}

function redactText(value: string): string {
  return value.replace(/\$\{[A-Z_][A-Z0-9_]*\}/gu, '[redacted-secret-ref]');
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested)]),
    );
  }
  return value;
}
