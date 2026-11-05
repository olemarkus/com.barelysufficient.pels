import type { DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions } from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Zendure SolarFlow 2400 AC and 800 Pro through the local Zendure app
 * (`com.tweakers.zendure` 1.0.16, driver `zendure`), read from the shipped
 * package:
 *
 * - The driver declares no `target_power` or `target_power_mode`
 *   (`app.json` `drivers[zendure].capabilities`), so Homey's standard binding
 *   finds nothing to claim. Its one control is the app's Flow action card.
 * - `set-power` (`app.json` `flow.actions`; args `device` filtered to
 *   `driver_id=zendure`, `power` number -2400..2400 step 1) runs `setPower`
 *   on the battery itself (`drivers/zendure/driver.js:17`,
 *   `drivers/zendure/device.js:64`). A positive power discharges: `acMode`
 *   2 with `outputLimit` = power; a negative one charges: `acMode` 1 with
 *   `inputLimit` = |power| (`device.js:71-76`), sent over the battery's local
 *   HTTP API. 0 writes both limits 0 and `smartMode` 0: the battery idles.
 * - `measure_power` is the grid input power while charging, else minus the
 *   home output power (`device.js:247`): positive while charging, Homey's
 *   sign, so the executor's verification and sign check read it unchanged.
 *
 * Hand-back. The app has no card that returns the battery to a mode of its
 * own: `set-power` is the app's only control, and 0 is its idle (`device.js:61`).
 * So the hand-back is `set-power` 0, which leaves the battery idle at 0 W
 * until the owner's own flows set it again, and a 0 W hold is the same card.
 * That is safe here, unlike Zinvolt's 0 W (`zinvolt/`): an app-action battery
 * reports no claim PELS reads back, so a hold that looks like a hand-back is
 * never taken for the owner taking the battery back.
 *
 * The 15 s poll (`device.js:91-98`) drops a charge that has not moved yet.
 * Its `smartMode` policy (`:194-205`) writes `{ smartMode: 0 }` alone when
 * the battery reads idle: `outputLimit` 0 and both powers 0. A charge always
 * has `outputLimit` 0, so a charge on a full battery, or one still ramping,
 * gets `smartMode` 0 within one or two polls. The battery then runs from the
 * values in its flash and the charge PELS set in RAM (`smartMode` 1) is gone.
 * So a charge expires: PELS declares `CHARGE_LIFETIME_MS` and the storage
 * lane sends it again at a third of that, a `smartMode` 1 write to RAM only,
 * which puts a dropped charge back in force within 30 s.
 *
 * A discharge has `outputLimit` > 0, never reads idle, and holds until the
 * next command (`persistent`). So does the 0 W hold, which is itself the
 * app's idle (`smartMode` 0, both limits 0): a flash write, which PELS must
 * not repeat on a timer.
 *
 * The card cannot fail on a battery that did not take the command: a write
 * that fails twice is logged and the run resolves (`device.js:136-141`). Only
 * the executor's verification against `measure_power` sees such a command.
 *
 * Range: the card's own ±2400 W. An 800 Pro that delivers less teaches PELS
 * its plateau (`lib/battery/batteryVerification.ts`).
 */
const ZENDURE_LOCAL_APP_ID = 'com.tweakers.zendure';
const ZENDURE_LOCAL_DRIVER_ID = 'zendure';

const ZENDURE_RANGE_W = 2400;

/**
 * How long PELS counts on a charge, ms. The app's poll drops one that reads
 * idle within two 15 s polls; a re-send every 30 s (a third) restores it.
 */
const CHARGE_LIFETIME_MS = 90_000;

const setPower = (deviceId: string, power: number): DeviceActionStep => (
  { deviceId, actionId: 'set-power', args: { power } }
);

const zendureActions = (deviceId: string): HomeBatteryActions => ({
  range: { minW: -ZENDURE_RANGE_W, maxW: ZENDURE_RANGE_W, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  // PELS's charge is the app's negative power.
  command: (setpointW) => [setPower(deviceId, setpointW === 0 ? 0 : -setpointW)],
  handBack: [setPower(deviceId, 0)],
});

const ZENDURE_LOCAL_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  appUri: `homey:app:${ZENDURE_LOCAL_APP_ID}`,
  // PELS's sign: a positive setpoint charges.
  commandLifetime: (setpointW) => (setpointW > 0
    ? { kind: 'expires', lifetimeMs: CHARGE_LIFETIME_MS }
    : { kind: 'persistent' }),
  resolve: (device) => ({ kind: 'resolved', actions: zendureActions(device.id) }),
};

/*
 * The Zendure cloud app (`com.zendure.flow` 1.0.25) is not bound here and
 * keeps Homey's standard binding: PELS only watches it. Its battery drivers
 * (SolarFlow 800, 800 Plus, 800 Pro, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro,
 * 4000 Mix AC+, 4000 Mix Pro, Hyper 2000) offer `<driver>-switch-ac-input-mode`
 * and `<driver>-switch-ac-output-mode` cards (W), but declare no
 * `measure_power` (`app.json` `drivers[].capabilities`: `measure_battery`,
 * `battery_charging_state`), so PELS could not verify a single command. A
 * failed card run is also swallowed and returns `false`
 * (`drivers/hyper-2000/driver.js:337-361`, the same in each driver).
 */
export const zendureLocalAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, ZENDURE_LOCAL_APP_ID, ZENDURE_LOCAL_DRIVER_ID),
  homeBatteryBinding: () => ZENDURE_LOCAL_BINDING,
};
