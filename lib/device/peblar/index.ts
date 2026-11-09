/**
 * The community Peblar app (`com.KyleMichiels.Peblar`, `peblar_charger`
 * driver, local REST) at the SDK seam. See `notes/native-wiring/peblar.md`.
 *
 * `peblar_charge_limit` is the charger's live charge limit (`evinterface`
 * `ChargeCurrentLimit`), in whole amps from 6 A; the app reads it back on
 * every poll. `evcharger_charging = false` sets that limit to 0 (the app allows
 * three pauses per ten minutes); `true` sets it to the charger's allowed
 * maximum. `createCurrentSwitchChargerAdapter` holds the rest.
 */
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { createCurrentSwitchChargerAdapter } from '../currentSwitchCharger';

const CURRENT_CAPABILITY_ID = 'peblar_charge_limit';
const CURRENT_FLOW_CARD_ID = 'peblar_set_charge_current';
const DRIVER_IDS = new Set([
  'homey:app:com.kylemichiels.peblar:peblar_charger', 'com.kylemichiels.peblar:peblar_charger',
]);
/** A phase carrying more than this is live. */
const LIVE_PHASE_VOLTAGE = 50;

function isPeblarCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

function readVolts(values: DeviceCapabilityMap | undefined, capabilityId: string): number | undefined {
  const volts = values?.[capabilityId]?.value;
  return typeof volts === 'number' && Number.isFinite(volts) ? volts : undefined;
}

/**
 * One phase when the charger is forced to it (`peblar_force_1_phase`),
 * otherwise as many as its meter sees live: three when L2 or L3 is.
 */
function phases(_device: HomeyDeviceLike, values: DeviceCapabilityMap | undefined): 1 | 3 | undefined {
  const forced = values?.peblar_force_1_phase?.value;
  if (forced === true) return 1;
  const l2 = readVolts(values, 'peblar_voltage_l2');
  const l3 = readVolts(values, 'peblar_voltage_l3');
  if (forced !== false || (l2 === undefined && l3 === undefined)) return undefined;
  return (l2 ?? 0) > LIVE_PHASE_VOLTAGE || (l3 ?? 0) > LIVE_PHASE_VOLTAGE ? 3 : 1;
}

export const peblarAdapter = createCurrentSwitchChargerAdapter({
  currentCapabilityId: CURRENT_CAPABILITY_ID,
  currentFlowCardId: CURRENT_FLOW_CARD_ID,
  matches: isPeblarCharger,
  matchesCapabilities: (capabilities) => capabilities.includes(CURRENT_CAPABILITY_ID),
  phases,
});
