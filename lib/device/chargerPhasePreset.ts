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
 * type not yet detected, unsupported IT three-phase, and a two-phase or faulted installation are all
 * `not_reported`, and the owner picks, rather than PELS guessing a phase count
 * that could understate what the charger draws.
 */
export type ChargerPhaseReport =
  | { kind: 'reported'; preset: TargetPowerSteppedLoadPreset }
  | { kind: 'not_reported' };

import { getDeviceAdapter } from './deviceAdapterRegistry';

export function resolveChargerPhaseReport(device: HomeyDeviceLike): ChargerPhaseReport {
  return getDeviceAdapter(device).phaseReport(device);
}

/** The reported control mode of every charger in a device list that reports one. */
export function resolveChargerPhasePresets(devices: readonly HomeyDeviceLike[]): ChargerPhasePresets {
  return Object.fromEntries(devices.flatMap((device) => {
    const report = resolveChargerPhaseReport(device);
    return report.kind === 'reported' ? [[device.id, report.preset]] : [];
  }));
}
