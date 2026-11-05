import type { DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions } from '../deviceAdapter';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Marstek Venus through the Marstek Battery Connector app
 * (`com.niewold.marstek` 0.9.1, local driver `marstek-venus`), read from the
 * shipped package:
 *
 * - The driver declares no `target_power` or `target_power_mode`
 *   (`app.json` `drivers[marstek-venus].capabilities`), so Homey's standard
 *   binding finds nothing to claim. Control is the driver's own Flow action
 *   cards, run with the owner's Homey API key.
 * - `marstek_passive_mode` (`app.json` `flow.actions`; args `device`,
 *   `power` number step 1 with no title, `seconds` number min 1 step 60)
 *   runs `setModePassive` (`drivers/marstek-venus/driver.js:324`, `:427`):
 *   it rejects a non-number and seconds below 1 (`:433`) and sends
 *   `ES.SetMode` with `mode: 'Passive'`, `passive_cfg: { power, cd_time:
 *   seconds }` (`:440`), unchanged.
 * - `marstek_auto_mode` (no args besides `device`) runs `setModeAuto`
 *   (`driver.js:319`, `:331`): `mode: 'Auto'`, `auto_cfg.enable: 1`, the
 *   battery's own self-consumption mode. It is the hand-back.
 * - `measure_power` is `bat_power` (`drivers/marstek-venus/device.js:203`),
 *   positive while charging (`:199`): Homey's sign, so the executor's
 *   verification and sign check read it unchanged.
 *
 * `passive_cfg.power` is negative to charge and positive to discharge, the
 * opposite of PELS's sign: the device's convention, as the same app titles its
 * Manual-mode `power` "Watt (negative = charge)" (`app.json`
 * `flow.actions[marstek_manual_mode]`) and accepts negative passive power
 * (`README.txt:52`). The app passes the value through unchanged.
 *
 * `cd_time` is a countdown: the command lasts that long. PELS sends 300 s
 * (the Open API's own example) and declares that lifetime, so the storage
 * lane sends the setpoint in force again before it runs out.
 *
 * Range: the package declares none. ±2500 W is the Venus's own range as
 * `com.kaoh.marstek` 1.5.23, the other Marstek app, declares it on the same
 * hardware (`target_power` min -2500, max 2500). A battery that delivers less
 * teaches PELS its plateau (`lib/battery/batteryVerification.ts`).
 *
 * The cloud driver `marstek-venus-cloud` offers no cards (every card filters
 * `driver_id=marstek-venus`) and keeps Homey's standard binding: with no
 * `target_power` PELS only watches it.
 */
const MARSTEK_CONNECTOR_APP_ID = 'com.niewold.marstek';
const MARSTEK_LOCAL_DRIVER_ID = 'marstek-venus';

/** How long one passive command lasts, s: the Open API's own example countdown. */
export const MARSTEK_PASSIVE_SECONDS = 300;

const MARSTEK_RANGE_W = 2500;

const marstekActions = (deviceId: string): HomeBatteryActions => ({
  range: { minW: -MARSTEK_RANGE_W, maxW: MARSTEK_RANGE_W, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  // PELS's charge is the app's negative power.
  command: (setpointW) => [{
    deviceId,
    actionId: 'marstek_passive_mode',
    args: { power: setpointW === 0 ? 0 : -setpointW, seconds: MARSTEK_PASSIVE_SECONDS },
  }],
});

const MARSTEK_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  appUri: `homey:app:${MARSTEK_CONNECTOR_APP_ID}`,
  commandLifetime: () => ({ kind: 'expires', lifetimeMs: MARSTEK_PASSIVE_SECONDS * 1000 }),
  resolveHandBack: (device) => ({
    kind: 'resolved', steps: [{ deviceId: device.id, actionId: 'marstek_auto_mode', args: {} }],
  }),
  resolve: (device) => ({ kind: 'resolved', actions: marstekActions(device.id) }),
};

export const marstekConnectorAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, MARSTEK_CONNECTOR_APP_ID, MARSTEK_LOCAL_DRIVER_ID),
  homeBatteryBinding: () => MARSTEK_BINDING,
};
