import { vi } from 'vitest';
import type { DeviceDiagnosticsStateStore } from '../../lib/diagnostics/deviceDiagnosticsStateStore';
import { sanitizePersistedState, type PersistedDiagnosticsState } from '../../lib/diagnostics/deviceDiagnosticsModel';
import {
  DEVICE_DIAGNOSTICS_PERSIST_VERSION,
  DEVICE_DIAGNOSTICS_WINDOW_DAYS,
} from '../../lib/diagnostics/deviceDiagnosticsPersistence';

/**
 * The diagnostics state port over one in-memory value: what a spec of the
 * SERVICE needs (no I/O, the same sanitisation the real store runs on read),
 * with `write` a spy so a spec can count flushes and inspect what landed.
 * The real store's own behaviour is `test/integration/deviceDiagnosticsStateStore.test.ts`.
 */
export const createInMemoryDeviceDiagnosticsStateStore = (
  initial?: unknown,
): DeviceDiagnosticsStateStore & { write: ReturnType<typeof vi.fn>; current: () => unknown } => {
  let stored: unknown = initial;
  const write = vi.fn((state: PersistedDiagnosticsState) => {
    stored = structuredClone(state);
  });
  return {
    read: () => sanitizePersistedState({
      raw: stored,
      persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
      windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
    }),
    write,
    current: () => stored,
  };
};
