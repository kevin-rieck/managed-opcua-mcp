import { vi } from 'vitest';
import type {
  InspectionFailure,
  OpcUaInspectionModule,
} from '../../src/opcua/inspection-contracts.js';

export type SpyInspection = OpcUaInspectionModule & {
  browse: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  modelContext: ReturnType<typeof vi.fn>;
};

export function fakeInspection(): SpyInspection {
  const invalidResult = (): Promise<InspectionFailure> =>
    Promise.resolve({
      ok: false,
      error: { code: 'invalid_request', message: 'test' },
    });
  return {
    browse: vi.fn(invalidResult),
    inspect: vi.fn(invalidResult),
    read: vi.fn(invalidResult),
    modelContext: vi.fn(invalidResult),
  };
}
