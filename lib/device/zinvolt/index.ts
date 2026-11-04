import type { DeviceAdapter, HomeBatteryBinding } from '../deviceAdapter';
import { isDeviceOfApp, STANDARD_HOME_BATTERY_BINDING } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Zinvolt (`com.zinvolt` 1.1.0, drivers `base` and `power`). Homey's standard
 * binding: signed `target_power` (positive charges, declared -800..2000 W,
 * step 10) taken over through `target_power_mode` = `homey`.
 *
 * One quirk: the app has no idle setpoint. Its `target_power` listener
 * (`drivers/baseDevice.js`) rounds to 10 W and maps an exact 0 onto its own
 * `INACTIVE` mode (smart mode `CHARGED` with a 0 W charge limit), and every
 * poll then reports `target_power_mode` = `INACTIVE`. PELS would read that as
 * the owner taking the battery back (a takeover, which turns control off).
 *
 * The binding writes the app's smallest charge setpoint, 10 W, for a 0 W
 * hold, so the battery stays under `homey` and `INACTIVE` keeps one meaning:
 * someone other than PELS chose it. The other way, counting `INACTIVE` as
 * engaged under PELS's claim, would hide an owner who picks Inactive in the
 * Zinvolt app while PELS holds the battery, and would make PELS refuse a
 * battery the owner had left Inactive (it would read as already held). The
 * cost of this way is a 10 W trickle charge while PELS holds the battery at
 * 0 W, which a full battery does not take. A hand-back still writes an exact
 * 0: the app's Inactive is the idle state PELS hands the battery back in,
 * before it restores the recorded mode. A claim written on its own (before
 * the first setpoint after a hand-back) can show `INACTIVE` for one poll until
 * the setpoint follows; that reads as a contested claim, not a takeover.
 */
const ZINVOLT_APP_ID = 'com.zinvolt';

/** The app rounds `target_power` to 10 W, so 10 W is the smallest value it does not read as 0. */
const ZINVOLT_HOLD_W = 10;

const ZINVOLT_BINDING: HomeBatteryBinding = { ...STANDARD_HOME_BATTERY_BINDING, zeroSetpointW: ZINVOLT_HOLD_W };

export const zinvoltAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfApp(device, ZINVOLT_APP_ID),
  homeBatteryBinding: () => ZINVOLT_BINDING,
};
