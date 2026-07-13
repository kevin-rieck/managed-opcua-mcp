import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import type {
  CommissioningDiscoveryGateway,
  CommissioningDiscoveryResult,
  DraftSemanticControlCandidate,
} from '../../commissioning/discovery.js';
import { generateCommissioningMarkdownReport } from '../../commissioning/markdown-report.js';
import { appConfigSchema, type AppConfig } from '../../config/schema.js';
import {
  getOnlineValidation,
  type OnlineValidationReason,
  type OnlineValidationResult,
} from '../../mcp/online-validation.js';
import type { OpcUaGateway } from '../../opcua/gateway.js';
import {
  type CommandOutput,
  type GatewayFactory,
  formatValidationFailure,
  loadConfigForCli,
  parseOnlineTimeout,
  redactSecrets,
  waitForOnlineValidationAttempt,
} from '../command-support.js';

export interface SetupOptions {
  config: string;
  out: string;
  report: string;
  root?: string[];
  depth?: string;
  maxNodes?: string;
  onlineTimeoutMs?: string;
  force?: boolean;
  dryRun?: boolean;
}

interface SetupDependencies extends CommandOutput {
  gatewayFactory: GatewayFactory;
}

const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_NODES = 1_000;

export async function runSetupCommand(
  options: SetupOptions,
  dependencies: SetupDependencies,
): Promise<void> {
  const local = await loadConfigForCli(options.config);
  if (!local.ok) {
    dependencies.setExitCode(1);
    dependencies.stdout(
      `${JSON.stringify(
        redactSecrets({
          ok: false,
          resultClass: 'local_validation_failed',
          localValidation: { ok: false, errors: local.failure.validationErrors },
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }

  try {
    const loaded = local.loaded;
    const roots = options.root ?? loaded.config.read.roots.map((root) => root.nodeId);
    const request = {
      roots,
      maxDepth: parseBound(options.depth, DEFAULT_DEPTH, 0, 10, 'setup depth'),
      maxNodes: parseBound(options.maxNodes, DEFAULT_MAX_NODES, 1, 1_000, 'setup max-nodes'),
    };

    if (options.force !== true && options.dryRun !== true) {
      await ensureOutputsDoNotExist([options.out, options.report]);
    }

    const gateway = dependencies.gatewayFactory(loaded.config);
    if (!supportsCommissioningDiscovery(gateway)) {
      throw new Error('Configured OPC UA gateway does not support commissioning discovery.');
    }

    let discovery: CommissioningDiscoveryResult;
    let onlineDiagnostics: OnlineValidationResult;
    await gateway.connect();
    try {
      await waitForOnlineValidationAttempt(gateway, parseOnlineTimeout(options.onlineTimeoutMs));
      discovery = await gateway.discoverCommissioning(request);
      onlineDiagnostics = await getOnlineValidation(loaded.config, gateway, {});
    } finally {
      await gateway.close();
    }

    const draftConfig = generateDraftConfig(loaded.config, discovery);
    const report = generateSetupReport(discovery, loaded.config, options.out, onlineDiagnostics);
    if (options.dryRun !== true) {
      await writeOperatorFile(options.out, draftConfig, options.force === true);
      await writeOperatorFile(options.report, report, options.force === true);
    }

    const hasWarnings =
      discovery.findings.warnings.length > 0 || discovery.draftSemanticControls.length > 0;
    const blocked = discovery.findings.blocking.length > 0 || onlineDiagnostics.state !== 'valid';
    if (onlineDiagnostics.state === 'pending') dependencies.setExitCode(4);
    else if (blocked) dependencies.setExitCode(3);

    dependencies.stdout(
      `${JSON.stringify(
        redactSecrets({
          ok: !blocked,
          resultClass:
            onlineDiagnostics.state === 'pending'
              ? 'online_diagnostics_unavailable'
              : blocked
                ? 'online_blocking_errors'
                : hasWarnings
                  ? 'commissioning_warnings'
                  : 'success',
          commissioningState:
            onlineDiagnostics.state === 'valid' ? 'online_validated' : 'draft_created',
          generated: {
            configPath: options.out,
            reportPath: options.report,
            dryRun: options.dryRun === true,
          },
          recommendation: blocked ? 'not_ready_to_serve' : 'operator_review_required',
          discovery: {
            roots: discovery.coverage.requestedRoots,
            nodesVisited: discovery.coverage.nodesVisited,
            draftSemanticControls: discovery.draftSemanticControls.length,
            blockingErrors: discovery.findings.blocking.length,
            warnings: discovery.findings.warnings.length,
          },
          onlineDiagnostics: {
            state: onlineDiagnostics.state,
            blockingErrors: onlineDiagnostics.reasons.map(diagnosticEvidence),
          },
          nextActions: [
            `Review ${options.report} and edit ${options.out}.`,
            'Promote or reject every draft Semantic Control candidate; candidates are comments and are not executable.',
            `Run opcua-mcp validate --config ${options.out}, then opcua-mcp doctor --config ${options.out}.`,
            'Run opcua-mcp serve only after blocking errors are resolved and Operator review is complete.',
          ],
        }),
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    dependencies.setExitCode(1);
    dependencies.stdout(
      `${JSON.stringify(redactSecrets(formatValidationFailure(error)), null, 2)}\n`,
    );
  }
}

function supportsCommissioningDiscovery(
  gateway: OpcUaGateway,
): gateway is OpcUaGateway & CommissioningDiscoveryGateway {
  return 'discoverCommissioning' in gateway && typeof gateway.discoverCommissioning === 'function';
}

function generateDraftConfig(config: AppConfig, discovery: CommissioningDiscoveryResult): string {
  const draft = generateDraftAppConfig(config, discovery);
  const header = [
    '# Draft OPC UA MCP config — Operator review required before serve.',
    '# Generated Semantic Control candidates below are comments and cannot be executed.',
    '',
  ].join('\n');
  const candidates = [...discovery.draftSemanticControls]
    .sort((left, right) => left.suggestedName.localeCompare(right.suggestedName))
    .flatMap(candidateComments);
  return `${header}${YAML.stringify(draft, { lineWidth: 0 }).trimEnd()}\n${candidates.length === 0 ? '' : `\n${candidates.join('\n')}\n`}`;
}

function generateDraftAppConfig(
  config: AppConfig,
  discovery: CommissioningDiscoveryResult,
): AppConfig {
  const draft = structuredClone(config);
  const nodeIds = new Set(draft.read.roots.map((root) => root.nodeId));
  const usedNames = new Set([
    ...draft.read.roots.flatMap((root) => (root.label === undefined ? [] : [root.label])),
    ...(draft.controls?.items.map((control) => control.name) ?? []),
  ]);
  for (const suggestion of [...discovery.suggestedReadEntryPoints].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  )) {
    if (nodeIds.has(suggestion.nodeId)) continue;
    const label = uniqueName(suggestion.suggestedLabel, usedNames);
    draft.read.roots.push({
      nodeId: suggestion.nodeId,
      label,
      ...(suggestion.displayName === undefined ? {} : { description: suggestion.displayName }),
    });
    nodeIds.add(suggestion.nodeId);
    usedNames.add(label);
  }
  return appConfigSchema.parse(draft);
}

function uniqueName(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}_${String(suffix)}`)) suffix += 1;
  return `${preferred}_${String(suffix)}`;
}

function candidateComments(candidate: DraftSemanticControlCandidate): string[] {
  return [
    `# Draft Semantic Control candidate: ${safeComment(candidate.suggestedName)}`,
    '# inactive: true',
    `# nodeId: ${safeComment(candidate.nodeId)}`,
    `# dataType: ${safeComment(candidate.dataType)}`,
    '# TODO Operator: confirm identity, constraints, Risk Level, and Risk Note before promotion.',
  ];
}

function generateSetupReport(
  discovery: CommissioningDiscoveryResult,
  config: AppConfig,
  generatedConfigPath: string,
  onlineDiagnostics: OnlineValidationResult,
): string {
  const commissioningReport = generateCommissioningMarkdownReport(discovery, {
    endpointUrl: config.connection.endpointUrl,
    authMode: config.connection.auth.type,
    generatedConfigPath,
  });
  const reportWithRecommendation =
    onlineDiagnostics.state === 'valid'
      ? commissioningReport
      : commissioningReport.replace(
          /Commissioning recommendation: `[^`]+`/u,
          'Commissioning recommendation: `not_ready_to_serve`',
        );
  const sanitizedDiagnostics = JSON.stringify(
    redactSecrets({
      state: onlineDiagnostics.state,
      blockingErrors: onlineDiagnostics.reasons.map(diagnosticEvidence),
    }),
    null,
    2,
  );
  return `${reportWithRecommendation}\n## 10. Setup online diagnostics\n\n\`\`\`json\n${sanitizedDiagnostics}\n\`\`\`\n`;
}

async function ensureOutputsDoNotExist(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      // Explicit Operator-selected output path.
      await access(path, constants.F_OK);
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }
    throw new Error(`Refusing to overwrite existing output ${path}; pass --force to replace it.`);
  }
}

async function writeOperatorFile(path: string, contents: string, force: boolean): Promise<void> {
  // Explicit Operator-selected output path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(path, contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
}

function diagnosticEvidence(reason: OnlineValidationReason): Record<string, unknown> {
  return {
    code: reason.code,
    ...(reason.nodeId === undefined ? {} : { nodeId: reason.nodeId }),
    ...(reason.label === undefined ? {} : { label: reason.label }),
    ...(reason.controlName === undefined ? {} : { controlName: reason.controlName }),
  };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function parseBound(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = Number(value ?? String(defaultValue));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return parsed;
}

function safeComment(value: string): string {
  return value
    .replace(/[\r\n]/gu, ' ')
    .replace(/\$\{[A-Z_][A-Z0-9_]*\}/gu, '[redacted-secret-ref]');
}
