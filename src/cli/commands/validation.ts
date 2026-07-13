import { loadConfigFile } from '../../config/load-config.js';
import {
  type CommandOutput,
  type GatewayFactory,
  formatValidationFailure,
  loadConfigForCli,
  parseOnlineTimeout,
  redactSecrets,
  runOnlineValidation,
} from '../command-support.js';

export interface ValidateConfigOptions {
  config: string;
  online?: boolean;
  onlineTimeoutMs?: string;
}

interface ValidationCommandDependencies extends CommandOutput {
  gatewayFactory: GatewayFactory;
  stderr: (text: string) => void;
}

export async function runValidateCommand(configPath: string, output: CommandOutput): Promise<void> {
  const result = await loadConfigForCli(configPath);
  if (result.ok) {
    output.stdout(
      `${JSON.stringify(redactSecrets({ ok: true, configHash: result.loaded.configHash }), null, 2)}\n`,
    );
    return;
  }
  output.setExitCode(1);
  output.stdout(`${JSON.stringify(redactSecrets(result.failure), null, 2)}\n`);
}

export async function runValidateConfigCommand(
  options: ValidateConfigOptions,
  dependencies: ValidationCommandDependencies,
): Promise<void> {
  dependencies.stderr('validate-config is deprecated; use validate instead.\n');
  if (options.online !== true) {
    await runValidateCommand(options.config, dependencies);
    return;
  }

  try {
    const loaded = await loadConfigFile(options.config);
    const output: Record<string, unknown> = { ok: true, configHash: loaded.configHash };
    output['onlineValidation'] = await runOnlineValidation(
      loaded,
      dependencies.gatewayFactory,
      parseOnlineTimeout(options.onlineTimeoutMs),
    );
    dependencies.stdout(`${JSON.stringify(redactSecrets(output), null, 2)}\n`);
  } catch (error) {
    dependencies.setExitCode(1);
    dependencies.stdout(
      `${JSON.stringify(redactSecrets(formatValidationFailure(error)), null, 2)}\n`,
    );
  }
}
