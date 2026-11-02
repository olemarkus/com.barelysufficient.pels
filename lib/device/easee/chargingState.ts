import type { EvChargingState } from '../../../packages/contracts/src/types';
import type { DeviceCapabilityMap } from '../managerControl';

export const EASEE_CHARGER_STATUS = 'charger_status';

// Easee's Completed means the car is still connected but no longer requests
// energy. Its Homey app publishes plugged_out for that mode, unlike a physical
// disconnect (Standby). Resolve the distinction before it reaches session owners.
const STATES = {
  Offline: 'plugged_out',
  Standby: 'plugged_out',
  Paused: 'plugged_in_paused',
  Charging: 'plugged_in_charging',
  Completed: 'plugged_in',
  Error: 'plugged_out',
  'Car connected': 'plugged_in',
  'Awaiting Authentication': 'plugged_in',
  Deauthenticating: 'plugged_in',
} satisfies Record<string, EvChargingState>;

export type EaseeChargingStatus = keyof typeof STATES;

export const isEaseeChargingStatus = (value: unknown): value is EaseeChargingStatus => (
  typeof value === 'string' && Object.hasOwn(STATES, value)
);

export const easeeChargingState = (status: EaseeChargingStatus): EvChargingState => STATES[status];

/** The vendor status owns both the state and its source date on a complete read. */
export function withEaseeChargingState(
  capabilities: readonly string[], values: DeviceCapabilityMap,
): DeviceCapabilityMap {
  if (!capabilities.includes(EASEE_CHARGER_STATUS)) return values;
  const status = values[EASEE_CHARGER_STATUS];
  if (!isEaseeChargingStatus(status?.value)) return values;
  return {
    ...values,
    evcharger_charging_state: {
      ...values.evcharger_charging_state,
      value: easeeChargingState(status.value),
      lastUpdated: status.lastUpdated,
    },
  };
}
