#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { JsonlAuditSink } from '../audit/jsonl-audit-sink.js';
import { loadConfigFile } from '../config/load-config.js';
import { startMcpServer } from '../mcp/server.js';
import type { AppConfig } from '../config/schema.js';
import type { OpcUaGateway } from '../opcua/gateway.js';
import { NodeOpcUaGateway } from '../opcua/node-opcua-gateway.js';
import { runDoctorCommand, type DoctorOptions } from './commands/doctor.js';
import {
  runValidateCommand,
  runValidateConfigCommand,
  type ValidateConfigOptions,
} from './commands/validation.js';

export interface CliProgramOptions {
  gatewayFactory?: (config: AppConfig) => OpcUaGateway;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export function createCliProgram(options: CliProgramOptions = {}): Command {
  const gatewayFactory =
    options.gatewayFactory ?? ((config) => new NodeOpcUaGateway({ connection: config.connection }));
  const stdout = options.stdout ?? ((text) => console.log(text));
  const stderr = options.stderr ?? ((text) => console.error(text));
  const setExitCode =
    options.setExitCode ??
    ((code) => {
      process.exitCode = code;
    });

  const program = new Command();

  program
    .name('opcua-mcp')
    .description('MCP server for OPC UA browsing, reading, and native writes')
    .version('0.2.0')
    .exitOverride((error) => {
      if (error.exitCode !== 0) setExitCode(2);
      throw error;
    });

  program
    .command('validate')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .option('--json', 'Emit JSON validation output (default)')
    .description('Validate local config schema and safety rules without OPC UA network I/O')
    .action(async (actionOptions: { config: string }) => {
      await runValidateCommand(actionOptions.config, { stdout, setExitCode });
    });

  program
    .command('doctor')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .option('--format <format>', 'Output format: json', 'json')
    .option(
      '--online-timeout-ms <number>',
      'Maximum time to wait for online validation connection',
      '5000',
    )
    .description('Run local validation and online root diagnostics')
    .action(async (actionOptions: DoctorOptions) => {
      await runDoctorCommand(actionOptions, { gatewayFactory, stdout, setExitCode });
    });

  program
    .command('validate-config')
    .requiredOption('-c, --config <path>', 'Path to YAML config')
    .option('--online', 'Also validate against the configured OPC UA Server when reachable')
    .option(
      '--online-timeout-ms <number>',
      'Maximum time to wait for online validation connection',
      '5000',
    )
    .description(
      'Deprecated alias for validate; --online keeps the previous networked validation behavior',
    )
    .action(async (actionOptions: ValidateConfigOptions) => {
      await runValidateConfigCommand(actionOptions, {
        gatewayFactory,
        stdout,
        stderr,
        setExitCode,
      });
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

  return program;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await createCliProgram().parseAsync(process.argv);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
}
