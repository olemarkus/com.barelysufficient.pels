import type {
  DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions, HomeBatteryWatchOnlyBinding,
} from '../deviceAdapter';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Marstek Venus through the Marstek Battery Connector app
 * (`com.niewold.marstek`, local driver `marstek-venus`):
 *
 * - The driver declares no `target_power` or `target_power_mode`, so Homey's
 *   standard binding finds nothing to claim. Control is the driver's own Flow
 *   action cards, run with the owner's Homey API key.
 * - `marstek_passive_mode` (args `device`, `power` number step 1 with no
 *   title, `seconds` number min 1 step 60) puts the battery in Passive mode
 *   at that power for that many seconds. The card refuses a non-number and
 *   seconds below 1.
 * - `marstek_auto_mode` (no args besides `device`) returns the battery to
 *   Auto, its own self-consumption mode. It is the hand-back.
 * - `measure_power` is positive while charging: Homey's sign, so the
 *   executor's verification and sign check read it unchanged.
 *
 * The passive `power` is negative to charge and positive to discharge, the
 * opposite of PELS's sign: the device's convention, as the same app titles
 * its Manual-mode `power` "Watt (negative = charge)" and its store
 * description states negative passive power.
 *
 * `seconds` is a countdown: the command lasts that long. PELS sends 300 s
 * and declares that lifetime, so the storage lane sends the setpoint in
 * force again before it runs out.
 *
 * Range: the app declares none. ±2500 W is the Venus's own range as
 * `com.kaoh.marstek`, the other Marstek app, declares it on the same hardware
 * (`target_power` min -2500, max 2500). A battery that delivers less teaches
 * PELS its plateau (`lib/battery/batteryVerification.ts`).
 *
 * The cloud driver `marstek-venus-cloud` offers no cards (every card is for
 * `driver_id=marstek-venus`), and the Bluetooth driver `marstek-venus-ble`
 * offers only an on/off work mode: PELS only watches either, and tells the
 * owner that the local driver is the one it controls.
 *
 * The local driver reads the battery over its Local API. With that API off,
 * the app lists the battery's readings and fills none, which PELS reads as
 * the Local API being off (`noReadingsCause`).
 */
const MARSTEK_CONNECTOR_APP_ID = 'com.niewold.marstek';
const MARSTEK_LOCAL_DRIVER_ID = 'marstek-venus';
/**
 * The app's Bluetooth and cloud drivers take no power setpoint: its store page
 * says Bluetooth sets only an on/off work mode, and the cloud driver offers no
 * cards. The app controls the same battery through the local driver.
 */
const MARSTEK_WATCH_ONLY_DRIVER_IDS = ['marstek-venus-ble', 'marstek-venus-cloud'] as const;
const MARSTEK_DRIVER_IDS = [MARSTEK_LOCAL_DRIVER_ID, ...MARSTEK_WATCH_ONLY_DRIVER_IDS] as const;

/** How long one passive command lasts, s: the Open API's own example countdown. */
export const MARSTEK_PASSIVE_SECONDS = 300;

const MARSTEK_RANGE_W = 2500;

const marstekActions = (deviceId: string): HomeBatteryActions => ({
  target: { appUri: `homey:app:${MARSTEK_CONNECTOR_APP_ID}`, deviceId },
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
  // The local driver reads the battery over its Local API, and reports nothing while that API is off.
  noReadingsCause: 'local_api_off',
  commandLifetime: () => ({ kind: 'expires', lifetimeMs: MARSTEK_PASSIVE_SECONDS * 1000 }),
  resolveTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${MARSTEK_CONNECTOR_APP_ID}`, deviceId: device.id },
  }),
  resolveLegacyTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${MARSTEK_CONNECTOR_APP_ID}`, deviceId: device.id },
  }),
  handBack: (target) => [{ deviceId: target.deviceId, actionId: 'marstek_auto_mode', args: {} }],
  resolve: (device) => ({ kind: 'resolved', actions: marstekActions(device.id) }),
};

const MARSTEK_WATCH_ONLY_BINDING: HomeBatteryWatchOnlyBinding = {
  kind: 'watch_only', reason: 'controlled_through_local_device',
};

export const marstekConnectorAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => MARSTEK_DRIVER_IDS.some((driverId) => (
    isDeviceOfAppDriver(device, MARSTEK_CONNECTOR_APP_ID, driverId)
  )),
  homeBatteryBinding: (device) => (
    isDeviceOfAppDriver(device, MARSTEK_CONNECTOR_APP_ID, MARSTEK_LOCAL_DRIVER_ID)
      ? MARSTEK_BINDING : MARSTEK_WATCH_ONLY_BINDING
  ),
};
