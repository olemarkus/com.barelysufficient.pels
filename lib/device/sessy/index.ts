import type { DeviceAdapter, HomeBatteryBinding } from '../deviceAdapter';
import { HOMEY_TARGET_POWER_DEFAULTS, isDeviceOfApp, STANDARD_HOME_BATTERY_CLAIM } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Sessy (`nl.sessy`), verified against the Sessy app's source
 * (`drivers/sessy/device.js` and `driver.compose.json`):
 *
 * - `control_strategy` is a setable enum whose values include
 *   `POWER_STRATEGY_API`, the strategy that hands the battery to Homey. Sessy
 *   declares no `target_power_mode`; the standard claim is still offered first,
 *   should a later version declare it.
 * - The `target_power` listener acts only under `POWER_STRATEGY_API`
 *   (`setPowerSetpoint` throws otherwise, unless the owner set
 *   `force_control_strategy`), so the claim is written before any setpoint
 *   while the battery does not report it.
 *   It writes `power_setpoint = -target_power`, and a positive
 *   `power_setpoint` discharges: Homey's sign, positive charges.
 * - `setControlStrategy` throws unless the device uses its local login
 *   (`useLocalLogin`). A Sessy connected through its cloud login rejects every
 *   claim, so a rejected claim write means its app refuses control
 *   (`app_refuses_control`), not a battery that did not answer.
 * - The driver declares no `target_power` min, max or step. Its edges are then
 *   the app's own charge-mode presets, `setChargeMode` (`CHARGE` sets
 *   `power_setpoint` -2200, `DISCHARGE` +1800, and `target_power` is
 *   `-power_setpoint`). Homey's ±25 kW would let PELS credit a whole deficit
 *   to a 2.2 kW battery until it learned a plateau. An edge the driver declares
 *   always wins.
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
