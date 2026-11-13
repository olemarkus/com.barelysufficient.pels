import type { DeviceAdapter, HomeBatteryBinding } from '../deviceAdapter';
import { HOMEY_TARGET_POWER_DEFAULTS, isDeviceOfApp, STANDARD_HOME_BATTERY_CLAIM } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Sessy (`nl.sessy`), as the app and battery behave:
 *
 * - `control_strategy` is a setable enum whose values include
 *   `POWER_STRATEGY_API`, the strategy that hands the battery to Homey. Sessy
 *   declares no `target_power_mode`; the standard claim is still offered first,
 *   should a later version declare it.
 * - `target_power` is refused unless `control_strategy` is
 *   `POWER_STRATEGY_API` (or the owner set `force_control_strategy`), so the
 *   claim is written before any setpoint while the battery does not report
 *   it. `target_power` uses Homey's sign: positive charges.
 * - A Sessy connected through its cloud login refuses the strategy claim, so
 *   a rejected claim write means its app refuses control
 *   (`app_refuses_control`), not a battery that did not answer.
 * - The driver declares no `target_power` min, max or step. Its edges are then
 *   the app's own Charge and Discharge presets, 2200 W charging and 1800 W
 *   discharging. Homey's ±25 kW would let PELS credit a whole deficit to a
 *   2.2 kW battery until it learned a plateau. Homey fills the missing edges
 *   with that ±25 kW itself, so PELS reads Homey's own default as left out
 *   (`batteryControlWiring.ts`). Any other edge the driver declares always
 *   wins.
 */
const SESSY_APP_ID = 'nl.sessy';

const SESSY_BINDING: HomeBatteryBinding = {
  kind: 'capability',
  claims: [
    STANDARD_HOME_BATTERY_CLAIM,
    { capabilityId: 'control_strategy', homeyValue: 'POWER_STRATEGY_API', rejection: 'app_refuses_control' },
  ],
  setpointSign: 1,
  rangeDefaults: { minW: -1800, maxW: 2200, stepW: HOMEY_TARGET_POWER_DEFAULTS.stepW },
  zeroSetpointW: 0,
};

export const sessyAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfApp(device, SESSY_APP_ID),
  homeBatteryBinding: () => SESSY_BINDING,
};
