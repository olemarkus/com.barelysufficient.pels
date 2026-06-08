import type Homey from 'homey';
import type { DeviceDiagnosticsStateStore } from '../lib/diagnostics/deviceDiagnosticsStateStore';
import { sanitizePersistedState } from '../lib/diagnostics/deviceDiagnosticsModel';
import {
  DEVICE_DIAGNOSTICS_PERSIST_VERSION,
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DEVICE_DIAGNOSTICS_WINDOW_DAYS,
} from '../lib/diagnostics/deviceDiagnosticsService';

/**
 * Builds the {@link DeviceDiagnosticsStateStore}: the sole owner of the
 * `homey.settings` read/write for the diagnostics state blob. `read` runs the
 * version/window sanitisation so the service receives only typed state +
 * repair metadata; `write` persists the typed state.
 */
export const createDeviceDiagnosticsStateStore = (
  homey: Homey.App['homey'],
): DeviceDiagnosticsStateStore => ({
  read: () => sanitizePersistedState({
    raw: homey.settings.get(DEVICE_DIAGNOSTICS_STATE_KEY) as unknown,
    persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
    windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
  }),
  write: (state) => homey.settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, state),
});
