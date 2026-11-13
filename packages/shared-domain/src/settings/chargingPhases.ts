import type { ChargingPhaseSettingsMap } from '../../../contracts/src/chargingPhases';
import { isUnknownRecord } from '../recordGuards';

export const CHARGING_PHASE_SETTINGS_KEY = 'charging_phase_control';

/** The runtime and browser share one all-or-nothing settings contract. */
export function isChargingPhaseSettingsMap(value: unknown): value is ChargingPhaseSettingsMap {
  return isUnknownRecord(value) && Object.values(value).every((entry) => (
    isUnknownRecord(entry)
    && (entry.mode === 'automatic' || entry.mode === 'single' || entry.mode === 'three')
    && entry.installationConfirmed === true
  ));
}
