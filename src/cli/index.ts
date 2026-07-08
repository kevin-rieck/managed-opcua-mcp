#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import YAML from 'yaml';
import { z } from 'zod';
import { JsonlAuditSink } from '../audit/jsonl-audit-sink.js';
import { loadConfigFile, type LoadedConfig } from '../config/load-config.js';
import { getOnlineValidation } from '../mcp/online-validation.js';
import { startMcpServer } from '../mcp/server.js';
import type { AppConfig } from '../config/schema.js';
import type { BrowseNodeResult, NodeMetadataResult, OpcUaGateway, ReadValueResult } from '../opcua/gateway.js';
import { NodeOpcUaGateway } from '../opcua/node-opcua-gateway.js';

export interface CliProgramOptions {
  gatewayFactory?: (config: AppConfig) => OpcUaGateway;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface DiscoverOptions {
  config: string;
  root: string;
  out: string;
  depth?: string;
}

const OPERATOR_REVIEW_WARNING =
  'Operator review is required before activation. Generated draft entries are inactive and were not merged into the running config.';

export function createCliProgram(options: CliProgramOptions = {}): Command {
  const gatewayFactory = options.gatewayFactory ?? ((config) => new NodeOpcUaGateway({ connection: config.connection }));
  const stdout = options.stdout ?? ((text) => console.log(text));
  const setExitCode = options.setExitCode ?? ((code) => {
    process.exitCode = code;
  });

  const program = new Command();

  program
    .name('opcua-mcp')
    .description('MCP server for scoped OPC UA read access and operator-approved semantic controls')
    .version('0.1.0');

  program
    .command('validate-config')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .option('--online', 'Also validate against the configured OPC UA Server when reachable')
    .option('--online-timeout-ms <number>', 'Maximum time to wait for online validation connection', '5000')
    .description('Validate local config schema and safety rules')
    .action(async (actionOptions: { config: string; online?: boolean; onlineTimeoutMs?: string }) => {
      try {
        const loaded = await loadConfigFile(actionOptions.config);
        const output: Record<string, unknown> = { ok: true, configHash: loaded.configHash };
        if (actionOptions.online === true) {
          output['onlineValidation'] = await runOnlineValidation(
            loaded,
            gatewayFactory,
            parseOnlineTimeout(actionOptions.onlineTimeoutMs),
          );
        }
        stdout(`${JSON.stringify(redactSecrets(output), null, 2)}\n`);
      } catch (error) {
        setExitCode(1);
        stdout(`${JSON.stringify(redactSecrets(formatValidationFailure(error)), null, 2)}\n`);
      }
    });

  program
    .command('serve')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .description('Start the MCP server over stdio')
    .action(async (actionOptions: { config: string }) => {
      const loaded = await loadConfigFile(actionOptions.config);
      await startMcpServer({
        config: loaded.config,
        configHash: loaded.configHash,
        gateway: gatewayFactory(loaded.config),
        auditSink: new JsonlAuditSink(loaded.config.audit.file),
      });
    });

  program
    .command('discover-controls')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .requiredOption('--root <nodeId>', 'Root NodeId to inspect')
    .requiredOption('--out <path>', 'Inactive draft output file')
    .option('--depth <number>', 'Browse depth for candidate discovery', '1')
    .description('Generate inactive draft Semantic Control entries for Operator review')
    .action(async (actionOptions: DiscoverOptions) => {
      try {
        const loaded = await loadConfigFile(actionOptions.config);
        const draft = await discoverControlDrafts(loaded.config, gatewayFactory, actionOptions);
        // Operator-selected output path.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(actionOptions.out, YAML.stringify(draft), 'utf8');
        stdout(`${JSON.stringify({ ok: true, out: actionOptions.out, warning: OPERATOR_REVIEW_WARNING }, null, 2)}\n`);
      } catch (error) {
        setExitCode(1);
        stdout(`${JSON.stringify(redactSecrets(formatValidationFailure(error)), null, 2)}\n`);
      }
    });

  return program;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await createCliProgram().parseAsync(process.argv);
}

async function runOnlineValidation(
  loaded: LoadedConfig,
  gatewayFactory: (config: AppConfig) => OpcUaGateway,
  timeoutMs: number,
): Promise<unknown> {
  const gateway = gatewayFactory(loaded.config);
  await gateway.connect();
  try {
    await waitForOnlineValidationAttempt(gateway, timeoutMs);
    return await getOnlineValidation(loaded.config, gateway, {});
  } finally {
    await gateway.close();
  }
}

async function waitForOnlineValidationAttempt(gateway: OpcUaGateway, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await gateway.status();
    if (status.state === 'connected') return;
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseOnlineTimeout(value: string | undefined): number {
  const timeoutMs = Number(value ?? '5000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new Error('validate-config online timeout must be an integer between 0 and 60000 milliseconds.');
  }
  return timeoutMs;
}

async function discoverControlDrafts(
  config: AppConfig,
  gatewayFactory: (config: AppConfig) => OpcUaGateway,
  options: DiscoverOptions,
): Promise<Record<string, unknown>> {
  const depth = parseDepth(options.depth);
  const gateway = gatewayFactory(config);
  await gateway.connect();
  try {
    const candidates = await gateway.browse(options.root, depth);
    const semanticControlDrafts = await Promise.all(
      candidates.map((candidate) => buildControlDraft(candidate, gateway)),
    );
    return {
      warning: OPERATOR_REVIEW_WARNING,
      sourceRoot: options.root,
      generatedAt: new Date().toISOString(),
      semanticControlDrafts,
    };
  } finally {
    await gateway.close();
  }
}

async function buildControlDraft(candidate: BrowseNodeResult, gateway: OpcUaGateway): Promise<Record<string, unknown>> {
  const [metadata, currentValue] = await Promise.all([
    readMetadata(candidate, gateway),
    readCurrentValue(candidate, gateway),
  ]);
  const draft: Record<string, unknown> = {
    active: false,
    name: candidateName(candidate),
    nodeId: candidate.nodeId,
    dataType: candidate.dataType ?? currentValue?.dataType ?? metadata?.dataType ?? 'TODO_DETECT_DATA_TYPE',
  };
  const writable = candidate.writable ?? metadata?.writable;
  if (writable !== undefined) draft['writable'] = writable;
  if (currentValue !== undefined) draft['currentValue'] = currentValue.value;
  draft['description'] = 'TODO: describe this Semantic Control before activation';
  draft['riskLevel'] = 'TODO_OPERATOR_REVIEW';
  draft['riskNote'] = 'TODO: document consequence and caution before activation';
  return draft;
}

async function readMetadata(candidate: BrowseNodeResult, gateway: OpcUaGateway): Promise<NodeMetadataResult | undefined> {
  if (gateway.getNodeMetadata === undefined) return undefined;
  try {
    return await gateway.getNodeMetadata(candidate.nodeId);
  } catch {
    return undefined;
  }
}

async function readCurrentValue(candidate: BrowseNodeResult, gateway: OpcUaGateway): Promise<ReadValueResult | undefined> {
  if (candidate.readable === false) return undefined;
  try {
    return await gateway.read(candidate.nodeId);
  } catch {
    return undefined;
  }
}

function candidateName(candidate: BrowseNodeResult): string {
  const source = candidate.displayName ?? candidate.browseName ?? candidate.nodeId;
  const withoutNamespace = source.includes(':') ? source.split(':').at(-1) ?? source : source;
  const snake = withoutNamespace
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return snake.length > 0 ? snake : 'candidate_control';
}

function parseDepth(value: string | undefined): number {
  const depth = Number(value ?? '1');
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
    throw new Error('discover-controls depth must be an integer between 1 and 10.');
  }
  return depth;
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, '[redacted-secret-ref]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSecretKey(key) ? '[redacted]' : redactSecrets(nested),
      ]),
    );
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return ['password', 'username', 'token', 'secret'].some((secretKey) => key.toLowerCase().includes(secretKey));
}

function formatValidationFailure(error: unknown): {
  ok: false;
  validationErrors: { path: string; message: string }[];
} {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      validationErrors: error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  return {
    ok: false,
    validationErrors: [
      {
        path: '(root)',
        message: error instanceof Error ? error.message : 'Unknown validation error.',
      },
    ],
  };
}
