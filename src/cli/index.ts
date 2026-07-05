#!/usr/bin/env node
import { Command } from 'commander';
import { z } from 'zod';
import { JsonlAuditSink } from '../audit/jsonl-audit-sink.js';
import { loadConfigFile } from '../config/load-config.js';
import { startMcpServer } from '../mcp/server.js';
import { NodeOpcUaGateway } from '../opcua/node-opcua-gateway.js';

const program = new Command();

program
  .name('opcua-mcp')
  .description('MCP server for scoped OPC UA read access and operator-approved semantic controls')
  .version('0.1.0');

program
  .command('validate-config')
  .requiredOption('-c, --config <path>', 'Path to YAML config')
  .description('Validate local config schema and safety rules')
  .action(async (options: { config: string }) => {
    try {
      const loaded = await loadConfigFile(options.config);
      console.log(JSON.stringify({ ok: true, configHash: loaded.configHash }, null, 2));
    } catch (error) {
      process.exitCode = 1;
      console.log(JSON.stringify(formatValidationFailure(error), null, 2));
    }
  });

program
  .command('serve')
  .requiredOption('-c, --config <path>', 'Path to YAML config')
  .description('Start the MCP server over stdio')
  .action(async (options: { config: string }) => {
    const loaded = await loadConfigFile(options.config);
    await startMcpServer({
      config: loaded.config,
      configHash: loaded.configHash,
      gateway: new NodeOpcUaGateway(),
      auditSink: new JsonlAuditSink(loaded.config.audit.file),
    });
  });

program
  .command('discover-controls')
  .requiredOption('-c, --config <path>', 'Path to YAML config')
  .requiredOption('--root <nodeId>', 'Root NodeId to inspect')
  .requiredOption('--out <path>', 'Inactive draft output file')
  .description('Generate inactive draft Semantic Control entries for Operator review')
  .action(() => {
    throw new Error('discover-controls is not implemented yet.');
  });

await program.parseAsync(process.argv);

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
