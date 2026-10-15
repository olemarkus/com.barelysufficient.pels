import type { HomeyDeviceLike } from '../../utils/types';
import type { ChargerPhaseReport } from '../chargerPhasePreset';
const NOT_REPORTED: ChargerPhaseReport = { kind: 'not_reported' };

// Easee 2.0.5 publishes these as read-only device settings, decoded to strings
// (`lib/enums.js`: `decodePhaseMode`, `decodePowerGridType`).
const EASEE_OWNER_URI = 'homey:app:no.easee';
const EASEE_PHASE_MODE_SETTING = 'phaseMode';
const EASEE_GRID_TYPE_SETTING = 'detectedPowerGridType';
const EASEE_PHASE_MODE_SINGLE = 'Locked to single phase';
const EASEE_PHASE_MODE_THREE = 'Locked to three phase';
// TN_1_PHASE, IT_1_PHASE and the operational WARNING_TN_1_PHASE_NEUTRAL_ON_PIN_3.
const EASEE_SINGLE_PHASE_GRID = /_1_PHASE(?:_|$)/u;
const EASEE_THREE_PHASE_GRID = 'TN_3_PHASE';

export function isEaseeDevice(device: HomeyDeviceLike): boolean {
  const ownerUri = device.ownerUri ?? device.driver?.owner_uri ?? device.driverUri ?? device.driver?.uri;
  if (ownerUri === EASEE_OWNER_URI) return true;
  const driverId = device.driverId ?? device.driver?.id;
  return typeof driverId === 'string' && driverId.startsWith(`${EASEE_OWNER_URI}:`);
}

export function resolveEaseePhaseReport(settings: HomeyDeviceLike['settings']): ChargerPhaseReport {
  const phaseMode = settings?.[EASEE_PHASE_MODE_SETTING];
  if (phaseMode === EASEE_PHASE_MODE_SINGLE) return { kind: 'reported', preset: 'ev_charger_1_phase' };
  const gridType = settings?.[EASEE_GRID_TYPE_SETTING];
  // The existing three-phase preset assumes 400 V TN (230 V per phase).
  // IT three-phase needs sqrt(3) * 230 W/A, which neither preset models.
  // Locked single-phase above remains valid on either grid; locked three-phase
  // must not bypass this topology check. Leave any authored mode untouched.
  if (gridType === 'IT_3_PHASE') return NOT_REPORTED;
  if (phaseMode === EASEE_PHASE_MODE_THREE) return { kind: 'reported', preset: 'ev_charger_3_phase' };
  // "Auto" (the charger switches phases itself) or no phase mode: the wiring
  // is the ceiling. A charger that can run three phases is planned as three.
  if (typeof gridType !== 'string') return NOT_REPORTED;
  if (EASEE_SINGLE_PHASE_GRID.test(gridType)) return { kind: 'reported', preset: 'ev_charger_1_phase' };
  if (gridType === EASEE_THREE_PHASE_GRID) return { kind: 'reported', preset: 'ev_charger_3_phase' };
  return NOT_REPORTED;
}
