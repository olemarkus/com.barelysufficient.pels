/**
 * The community Alfen Pro-line/ACE app (`Alfen.ProlineSingle`, `alfen-ace`
 * driver, Modbus TCP) at the SDK seam. See `notes/native-wiring/alfen.md`.
 *
 * `max_current` is the socket's Modbus charging current, in whole amps. The app
 * writes it, reads it back, lifts its own pause on any write, and keeps
 * rewriting the last written current so the charger's 60 s setpoint validity
 * never lapses. `evcharger_charging = false` pauses at 5 A, held by that same
 * keep-alive; `true` restores the current from before the pause, which may be
 * more than the house affords now. `createCurrentSwitchChargerAdapter` holds
 * the rest.
 */
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { createCurrentSwitchChargerAdapter } from '../currentSwitchCharger';

const CURRENT_CAPABILITY_ID = 'max_current';
const CURRENT_FLOW_CARD_ID = 'set_max_current';
/** Declared by every `alfen-ace` device; pairs with the current to tell this driver apart. */
const PAUSE_CAPABILITY_ID = 'charging_paused';
const DRIVER_IDS = new Set(['homey:app:alfen.prolinesingle:alfen-ace', 'alfen.prolinesingle:alfen-ace']);

function isProlineCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId?.trim().toLowerCase() ?? '');
}

/** The charger's own phase register (`charge_phases`, '1' or '3'), else the `grid_phases` setting. */
function phases(device: HomeyDeviceLike, values: DeviceCapabilityMap | undefined): 1 | 3 | undefined {
  const reported = values?.charge_phases?.value;
  if (reported === '1' || reported === '3') return reported === '1' ? 1 : 3;
  const setting = device.settings?.grid_phases;
  const parsed = typeof setting === 'string' ? Number(setting) : setting;
  return parsed === 1 || parsed === 3 ? parsed : undefined;
}

export const alfenProlineAdapter = createCurrentSwitchChargerAdapter({
  currentCapabilityId: CURRENT_CAPABILITY_ID,
  currentFlowCardId: CURRENT_FLOW_CARD_ID,
  matches: isProlineCharger,
  matchesCapabilities: (capabilities) => capabilities.includes(CURRENT_CAPABILITY_ID)
    && (capabilities.includes(PAUSE_CAPABILITY_ID)
      || capabilities.every((id) => id === CURRENT_CAPABILITY_ID || id === CURRENT_FLOW_CARD_ID)),
  phases,
});
