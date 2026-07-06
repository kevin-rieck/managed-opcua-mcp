import type { AppConfig } from '../config/schema.js';

export function resolveReadEntryPointLabel(config: AppConfig, label: string): string | undefined {
  for (const root of config.read.roots) {
    if (root.label === label) return root.nodeId;
  }
  return undefined;
}

export function getReadEntryPoints(config: AppConfig): AppConfig['read']['roots'] {
  return config.read.roots;
}
