import type { DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions } from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Zendure SolarFlow 2400 AC and 800 Pro through the local Zendure app
 * (`com.tweakers.zendure`, driver `zendure`):
 *
 * - The driver declares no `target_power` or `target_power_mode`, so Homey's
 *   standard binding finds nothing to claim. PELS controls it with the app's
 *   Flow action card.
 * - `set-power` (args `device` for `driver_id=zendure`, `power` number
 *   -2400..2400 step 1) sets the battery's power over its local API. A
 *   positive power discharges, a negative one charges, and 0 idles the
 *   battery.
 * - `measure_power` is positive while charging, Homey's sign, so the
 *   executor's verification and sign check read it unchanged.
 *
 * Hand-back. PELS uses no card that returns the battery to a mode of its own,
 * so the hand-back is `set-power` 0, which leaves the battery idle at 0 W
 * until the owner's own flows set it again, and a 0 W hold is the same card.
 * That is safe here, unlike Zinvolt's 0 W (`zinvolt/`): an app-action battery
 * reports no claim PELS reads back, so a hold that looks like a hand-back is
 * never taken for the owner taking the battery back.
 *
 * A charge that the battery has not started yet, or one on a full battery,
 * is dropped by the app within one or two of its 15 s polls, and the battery
 * falls back to its stored settings. So a charge expires: PELS declares
 * `CHARGE_LIFETIME_MS` and the storage lane sends it again at a third of
 * that, which puts a dropped charge back in force within 30 s.
 *
 * A discharge holds until the next command (`persistent`). So does the 0 W
 * hold, which is the app's own idle and is stored by the battery, so PELS
 * must not repeat it on a timer.
 *
 * The card does not fail when the battery did not take the command. Only the
 * executor's verification against `measure_power` sees such a command.
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
  target: { appUri: `homey:app:${ZENDURE_LOCAL_APP_ID}`, deviceId },
  range: { minW: -ZENDURE_RANGE_W, maxW: ZENDURE_RANGE_W, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  // PELS's charge is the app's negative power.
  command: (setpointW) => [setPower(deviceId, setpointW === 0 ? 0 : -setpointW)],
});

const ZENDURE_LOCAL_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  appUri: `homey:app:${ZENDURE_LOCAL_APP_ID}`,
  // PELS's sign: a positive setpoint charges.
  commandLifetime: (setpointW) => (setpointW > 0
    ? { kind: 'expires', lifetimeMs: CHARGE_LIFETIME_MS }
    : { kind: 'persistent' }),
  resolveTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${ZENDURE_LOCAL_APP_ID}`, deviceId: device.id },
  }),
  resolveLegacyTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${ZENDURE_LOCAL_APP_ID}`, deviceId: device.id },
  }),
  handBack: (target) => [setPower(target.deviceId, 0)],
  resolve: (device) => ({ kind: 'resolved', actions: zendureActions(device.id) }),
};

/*
 * The Zendure cloud app (`com.zendure.flow`) is not bound here and keeps
 * Homey's standard binding: PELS only watches it. Its battery drivers
 * (SolarFlow 800, 800 Plus, 800 Pro, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro,
 * 4000 Mix AC+, 4000 Mix Pro, Hyper 2000) offer `<driver>-switch-ac-input-mode`
 * and `<driver>-switch-ac-output-mode` cards (W), but declare no
 * `measure_power` (only `measure_battery` and `battery_charging_state`), so
 * PELS could not verify a single command. A failed card run also reports
 * `false` rather than an error.
 */
export const zendureLocalAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, ZENDURE_LOCAL_APP_ID, ZENDURE_LOCAL_DRIVER_ID),
  homeBatteryBinding: () => ZENDURE_LOCAL_BINDING,
};
