import type { PersistedDiagnosticsState } from './deviceDiagnosticsModel';

/**
 * Result of reading the persisted diagnostics state: the sanitised state plus
 * the repair/reset metadata the service surfaces as a debug event. Mirrors the
 * shape of `sanitizePersistedState`, which the adapter runs.
 */
export type DeviceDiagnosticsStateRead = {
  state: PersistedDiagnosticsState;
  repaired: boolean;
  resetReason?: string;
};

/**
 * Domain-owned read/write boundary for the persisted device-diagnostics state
 * blob. The service depends on this type, never on `homey.settings`: the
 * adapter (`setup/deviceDiagnosticsStateAdapter`) owns the settings read +
 * version/window sanitisation and the write, returning only typed state.
 */
export type DeviceDiagnosticsStateStore = {
  read(): DeviceDiagnosticsStateRead;
  write(state: PersistedDiagnosticsState): void;
};
