import type { TargetPowerSteppedLoadPreset } from '../../packages/contracts/src/types';
import type { ChargerPhasePresets } from '../../packages/contracts/src/settingsUiApi';
import type { HomeyDeviceLike } from '../utils/types';

/**
 * What a charger's own app says about how the charger is wired, as an EV
 * control mode.
 *
 * This describes the INSTALLATION, not the charging session: a car that only
 * charges on one phase draws one phase from a three-phase charger. So a report
 * is only ever a starting point, written once when the owner opts the charger
 * in and never kept in sync; the owner's choice and the "Set EV charging
 * phase" Flow card, which exists to follow the car, own the saved mode from
 * then on.
 *
 * Only a report that names the phase count is `reported`. No report, a grid
 * type not yet detected, and a two-phase or faulted installation are all
 * `not_reported`, and the owner picks, rather than PELS guessing a phase count
 * that could understate what the charger draws.
 */
export type ChargerPhaseReport =
  | { kind: 'reported'; preset: TargetPowerSteppedLoadPreset }
  | { kind: 'not_reported' };

const NOT_REPORTED: ChargerPhaseReport = { kind: 'not_reported' };

export function resolveChargerPhaseReport(device: HomeyDeviceLike): ChargerPhaseReport {
  if (!isEaseeDevice(device)) return NOT_REPORTED;
  return resolveEaseePhaseReport(device.settings);
}

/** The reported control mode of every charger in a device list that reports one. */
export function resolveChargerPhasePresets(devices: readonly HomeyDeviceLike[]): ChargerPhasePresets {
  return Object.fromEntries(devices.flatMap((device) => {
    const report = resolveChargerPhaseReport(device);
    return report.kind === 'reported' ? [[device.id, report.preset]] : [];
  }));
}

// Easee 2.0.5 publishes these as read-only device settings, decoded to strings
// (`lib/enums.js`: `decodePhaseMode`, `decodePowerGridType`).
const EASEE_OWNER_URI = 'homey:app:no.easee';
const EASEE_PHASE_MODE_SETTING = 'phaseMode';
const EASEE_GRID_TYPE_SETTING = 'detectedPowerGridType';
const EASEE_PHASE_MODE_SINGLE = 'Locked to single phase';
const EASEE_PHASE_MODE_THREE = 'Locked to three phase';
// TN_1_PHASE, IT_1_PHASE and the operational WARNING_TN_1_PHASE_NEUTRAL_ON_PIN_3.
const EASEE_SINGLE_PHASE_GRID = /_1_PHASE(?:_|$)/u;
// TN_3_PHASE and IT_3_PHASE.
const EASEE_THREE_PHASE_GRID = /_3_PHASE$/u;

function isEaseeDevice(device: HomeyDeviceLike): boolean {
  const ownerUri = device.ownerUri ?? device.driver?.owner_uri ?? device.driverUri ?? device.driver?.uri;
  if (ownerUri === EASEE_OWNER_URI) return true;
  const driverId = device.driverId ?? device.driver?.id;
  return typeof driverId === 'string' && driverId.startsWith(`${EASEE_OWNER_URI}:`);
}

function resolveEaseePhaseReport(settings: HomeyDeviceLike['settings']): ChargerPhaseReport {
  const phaseMode = settings?.[EASEE_PHASE_MODE_SETTING];
  if (phaseMode === EASEE_PHASE_MODE_SINGLE) return { kind: 'reported', preset: 'ev_charger_1_phase' };
  if (phaseMode === EASEE_PHASE_MODE_THREE) return { kind: 'reported', preset: 'ev_charger_3_phase' };
  // "Auto" (the charger switches phases itself) or no phase mode: the wiring
  // is the ceiling. A charger that can run three phases is planned as three.
  const gridType = settings?.[EASEE_GRID_TYPE_SETTING];
  if (typeof gridType !== 'string') return NOT_REPORTED;
  if (EASEE_SINGLE_PHASE_GRID.test(gridType)) return { kind: 'reported', preset: 'ev_charger_1_phase' };
  if (EASEE_THREE_PHASE_GRID.test(gridType)) return { kind: 'reported', preset: 'ev_charger_3_phase' };
  return NOT_REPORTED;
}
