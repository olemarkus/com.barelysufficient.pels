import type { DeviceAdapter, HomeBatteryBinding } from '../deviceAdapter';
import { isDeviceOfApp, STANDARD_HOME_BATTERY_BINDING } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Anker SOLIX (`com.anker.solix`, driver `battery`). The app declares
 * its own `target_power` capability, titled "On-Grid Port Output Power (+) /
 * Grid-to-Battery Charge Power (-)": a positive value DISCHARGES, the
 * opposite of Homey's sign. Its Flow card hint says the same. So the binding
 * flips the sign of every setpoint PELS writes, and of the declared range
 * PELS reads (the app sets it to ±max(charge, discharge limit), step 100;
 * symmetric today, flipped all the same).
 *
 * `measure_power` is already Homey's sign: positive is charging. It is not
 * flipped, so the executor's sign check against the meter sees the battery
 * move the way PELS asked it to.
 *
 * The claim is the standard one: `target_power_mode` = `homey` (the app also
 * switches to `homey` on its own when `target_power` is written).
 */
const ANKER_SOLIX_APP_ID = 'com.anker.solix';

const ANKER_SOLIX_BINDING: HomeBatteryBinding = { ...STANDARD_HOME_BATTERY_BINDING, setpointSign: -1 };

export const ankerSolixAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfApp(device, ANKER_SOLIX_APP_ID),
  homeBatteryBinding: () => ANKER_SOLIX_BINDING,
};
