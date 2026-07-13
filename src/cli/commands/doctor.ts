import { CommanderError } from 'commander';
import type { AppConfig } from '../../config/schema.js';
import { getOnlineValidation, type OnlineValidationResult } from '../../mcp/online-validation.js';
import {
  type CommandOutput,
  type GatewayFactory,
  loadConfigForCli,
  parseOnlineTimeout,
  redactSecrets,
  waitForOnlineValidationAttempt,
} from '../command-support.js';

export interface DoctorOptions {
  config: string;
  format?: string;
  strictWarnings?: boolean;
  onlineTimeoutMs?: string;
}

interface DoctorWarning extends Record<string, unknown> {
  code: string;
  message: string;
}

export async function runDoctorCommand(
  options: DoctorOptions,
  dependencies: CommandOutput & { gatewayFactory: GatewayFactory },
): Promise<void> {
  if (options.format !== undefined && options.format !== 'json') {
    dependencies.setExitCode(2);
    throw new CommanderError(2, 'commander.invalidArgument', 'doctor only supports --format json');
  }

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

  const gateway = dependencies.gatewayFactory(local.loaded.config);
  let onlineValidation: OnlineValidationResult;
  try {
    await gateway.connect();
    await waitForOnlineValidationAttempt(gateway, parseOnlineTimeout(options.onlineTimeoutMs));
    onlineValidation = await getOnlineValidation(local.loaded.config, gateway, {});
  } finally {
    await gateway.close();
  }

  const warnings = commissioningWarnings(local.loaded.config);
  const base = {
    localValidation: { ok: true, configHash: local.loaded.configHash },
    onlineDiagnostics: doctorOnlineDiagnostics(onlineValidation),
    warnings,
  };

  if (onlineValidation.state === 'pending') {
    dependencies.setExitCode(4);
    dependencies.stdout(
      `${JSON.stringify(redactSecrets({ ok: false, resultClass: 'online_diagnostics_unavailable', ...base }), null, 2)}\n`,
    );
    return;
  }

  if (onlineValidation.state === 'invalid') {
    dependencies.setExitCode(3);
    dependencies.stdout(
      `${JSON.stringify(redactSecrets({ ok: false, resultClass: 'online_blocking_errors', ...base }), null, 2)}\n`,
    );
    return;
  }

  if (warnings.length > 0 && options.strictWarnings === true) {
    dependencies.setExitCode(5);
    dependencies.stdout(
      `${JSON.stringify(redactSecrets({ ok: false, resultClass: 'strict_warning_failure', ...base }), null, 2)}\n`,
    );
    return;
  }

  dependencies.stdout(
    `${JSON.stringify(
      redactSecrets({
        ok: true,
        resultClass: warnings.length > 0 ? 'commissioning_warnings' : 'success',
        ...base,
      }),
      null,
      2,
    )}\n`,
  );
}

function doctorOnlineDiagnostics(validation: OnlineValidationResult): Record<string, unknown> {
  if (validation.state === 'pending') {
    return {
      state: 'pending',
      unavailableReasons: validation.reasons,
      connectionGeneration: validation.connectionGeneration,
    };
  }
  return {
    state: validation.state,
    blockingErrors: validation.reasons,
    readRoots: validation.readRoots,
    controls: validation.controls,
    connectionGeneration: validation.connectionGeneration,
  };
}

function commissioningWarnings(config: AppConfig): DoctorWarning[] {
  if (config.controls === undefined) return [];
  if (!config.controls.enabled && config.controls.items.length > 0) {
    return [
      {
        code: 'controls_disabled',
        message:
          'controls.enabled is false; Semantic Controls are visible for commissioning but not executable.',
      },
    ];
  }
  return [];
}
