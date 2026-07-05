import type { AppConfig } from '../config/schema.js';

export function isNodeExplicitlyReadable(config: AppConfig, nodeId: string): boolean {
  return config.readScope.nodes.some((node) => node.nodeId === nodeId);
}

export function resolveReadLabel(config: AppConfig, label: string): string | undefined {
  for (const root of config.readScope.roots) {
    if (root.label === label) return root.nodeId;
  }
  for (const node of config.readScope.nodes) {
    if (node.label === label) return node.nodeId;
  }
  return undefined;
}

export function getReadRoots(config: AppConfig): AppConfig['readScope']['roots'] {
  return config.readScope.roots;
}
