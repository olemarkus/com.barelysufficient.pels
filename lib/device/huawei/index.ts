import type { HomeyDeviceLike } from '../../utils/types';
import type {
  DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions, HomeBatteryActionsResolution,
} from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Huawei LUNA2000 on its Modbus driver (`com.huawei.fusionsolar` 1.3.9,
 * driver `luna2000_modbus`), read from the shipped package:
 *
 * - The driver declares no `target_power` or `target_power_mode`
 *   (`app.json` `drivers[luna2000_modbus].capabilities`). Control is the
 *   driver's forced charge and discharge cards, app-level cards with the
 *   battery as their `device` argument (`driver_id=luna2000_modbus`),
 *   registered in `drivers/luna2000_modbus/device.js:996`.
 * - `luna2000_start_force_charge_duration` and
 *   `luna2000_start_force_discharge_duration` (`app.json` `flow.actions`;
 *   `power` W, 0..100000 step 100; `duration` minutes 1..1440;
 *   `device.js:724`, `:739`) write the power (47247 charge, 47249
 *   discharge), the minutes (47083), the duration mode (47246 = 0) and the
 *   start (47100 = 1 charge, 2 discharge), in that order, each only after the
 *   one before it succeeded; a failed step fails the card and starts nothing
 *   (`forceSequence`, `:595`). The power is unsigned W, clamped to the battery's own max
 *   charge or discharge power, and a max of 0 or less fails the card
 *   (`_forcePowerW`, `:1624`). The battery's own timer ends the run after the
 *   minutes (`:729`).
 * - `luna2000_stop_force_charge_discharge` (`:675`, `forceStop` `:643`)
 *   writes the stop (47100 = 0) and then clears the discharge power, minutes
 *   and mode: the battery returns to its own working mode. It is the
 *   hand-back. A stop that cannot be written fails the card.
 * - All three run one at a time per battery, in the order asked
 *   (`forceQueue`, `:586`), and wait for their writes.
 * - `measure_power` is the battery's charge/discharge power, positive while
 *   charging (`device.js:1150`, `:1157`): Homey's sign. It is read on the
 *   driver's poll, 60 s by default (`poll_interval` setting, 10..300 s).
 *
 * PELS's commands: charge W = forced charge at W for 10 minutes; discharge W
 * = forced discharge at W for 10 minutes; hold 0 W = forced charge at 0 W
 * for 10 minutes, which the card accepts (power min 0, `_forcePowerW` keeps
 * 0), rather than the stop, which would hand the battery back to its own
 * mode. A command expires after its minutes, so the storage lane sends it
 * again every 200 s (a third of it); when PELS stops, the battery's timer returns it to
 * its own mode within 10 minutes.
 *
 * Range: the battery's own max charge and discharge power (registers 47075,
 * 47077), which the poll keeps in the device settings `max_charge_power` and
 * `max_discharge_power` (W, `device.js:1455-1474`), on the cards' 100 W grid.
 * While either is unknown or 0 (which also makes its card fail), the battery
 * is unavailable and PELS only watches it.
 *
 * The EMMA driver `luna2000_emma_modbus` has only working-mode and grid-charge
 * cards, and the OpenAPI drivers are read-only: they keep Homey's standard
 * binding, and with no `target_power` PELS only watches them.
 */
const HUAWEI_APP_ID = 'com.huawei.fusionsolar';
const LUNA2000_MODBUS_DRIVER_ID = 'luna2000_modbus';

/** How long one forced run lasts, minutes. */
export const LUNA2000_FORCE_MINUTES = 10;

/** The cards take W on a 100 W grid. */
const STEP_W = 100;

/** A max power setting in W, on the cards' grid (rounded down); `undefined` while unknown or 0. */
const readMaxPowerW = (value: unknown): number | undefined => {
  const watts = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  const onGrid = Math.floor(watts / STEP_W) * STEP_W;
  return Number.isFinite(onGrid) && onGrid > 0 ? onGrid : undefined;
};

const luna2000Actions = (deviceId: string, chargeW: number, dischargeW: number): HomeBatteryActions => {
  const force = (actionId: string, power: number): DeviceActionStep => (
    { deviceId, actionId, args: { power, duration: LUNA2000_FORCE_MINUTES } }
  );
  return {
    target: { appUri: `homey:app:${HUAWEI_APP_ID}`, deviceId },
    range: { minW: -dischargeW, maxW: chargeW, stepW: STEP_W, excludeMinW: 0, excludeMaxW: 0 },
    command: (setpointW) => (setpointW < 0
      ? [force('luna2000_start_force_discharge_duration', -setpointW)]
      : [force('luna2000_start_force_charge_duration', setpointW)]),
  };
};

const resolveLuna2000 = (device: HomeyDeviceLike): HomeBatteryActionsResolution => {
  const chargeW = readMaxPowerW(device.settings.max_charge_power);
  const dischargeW = readMaxPowerW(device.settings.max_discharge_power);
  if (chargeW === undefined || dischargeW === undefined) {
    return { kind: 'unavailable', reasonCode: 'max_power_unknown' };
  }
  return { kind: 'resolved', actions: luna2000Actions(device.id, chargeW, dischargeW) };
};

const LUNA2000_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  appUri: `homey:app:${HUAWEI_APP_ID}`,
  commandLifetime: () => ({ kind: 'expires', lifetimeMs: LUNA2000_FORCE_MINUTES * 60_000 }),
  resolveTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${HUAWEI_APP_ID}`, deviceId: device.id },
  }),
  resolveLegacyTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${HUAWEI_APP_ID}`, deviceId: device.id },
  }),
  handBack: (target) => [{ deviceId: target.deviceId, actionId: 'luna2000_stop_force_charge_discharge', args: {} }],
  resolve: resolveLuna2000,
};

export const huaweiLuna2000Adapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, HUAWEI_APP_ID, LUNA2000_MODBUS_DRIVER_ID),
  homeBatteryBinding: () => LUNA2000_BINDING,
};
