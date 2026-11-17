import type { HomeBatterySetpointRange } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions } from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * A Fronius GEN24 battery through the Fronius Control app
 * (`se.andreas.fronius-modbus-control`, driver `gen24`, Modbus):
 *
 * - The battery device is class `battery` with `measure_power` and
 *   `measure_battery`, and declares no `target_power`. `measure_power` is
 *   positive while charging: Homey's sign.
 * - Control is the app's Flow action cards, each for `driver_id=gen24`, so
 *   every step runs on the battery device itself. The ones PELS uses:
 *   `set_charge_kw` (`power` in W, step 50; despite its id): charge at least
 *   that much, from the grid when solar falls short.
 *   `force_discharge_kw` (`power` in W, step 50): discharge at least that much.
 *   `pause_battery`: no discharge; solar may still charge the battery.
 *   `reset_control`: clear every restriction, the battery's own behaviour.
 * - A command holds until the next one (`persistent`).
 * - Every command is a write to the inverter's storage control over Modbus.
 *   PELS keeps those few (owner decision, 2026-11-17): the setpoint range is
 *   on a 300 W grid, and a command that raises grid import waits
 *   `IMPORT_RAISING_INTERVAL_MS` after the last one (`commandPacing`). So a
 *   house load that crosses a 300 W step and comes back costs no write at all.
 *
 * PELS's commands: charge W = `set_charge_kw`; discharge W =
 * `force_discharge_kw`; hold 0 W = `pause_battery`, the closest the app has,
 * under which the battery can still take solar; hand-back = `reset_control`.
 *
 * Range: the app's `maxBatteryKw` setting (kW), which the app fills in from
 * the inverter or the owner enters, on the 300 W grid. While it is 0 the
 * battery is unavailable and PELS only watches it.
 */
const FRONIUS_APP_ID = 'se.andreas.fronius-modbus-control';
const BATTERY_DRIVER_ID = 'gen24';
const MAX_POWER_SETTING = 'maxBatteryKw';

/** PELS's setpoint grid for this battery, W: a smaller change is not worth a control write. */
const STEP_W = 300;

/** How long a command that raises grid import waits after the last command, ms. */
export const IMPORT_RAISING_INTERVAL_MS = 5 * 60 * 1000;

/** The battery's maximum power in W on the grid, rounded down; `undefined` while the app has none. */
const readMaxPowerW = (device: HomeyDeviceLike): number | undefined => {
  const kw = device.settings[MAX_POWER_SETTING];
  if (typeof kw !== 'number' || !Number.isFinite(kw)) return undefined;
  const watts = Math.floor(Number((kw * 1000 / STEP_W).toFixed(6))) * STEP_W;
  return watts > 0 ? watts : undefined;
};

const froniusActions = (deviceId: string, range: HomeBatterySetpointRange): HomeBatteryActions => {
  const step = (actionId: string, args: Readonly<Record<string, unknown>> = {}): DeviceActionStep => (
    { deviceId, actionId, args }
  );
  return {
    target: { appUri: `homey:app:${FRONIUS_APP_ID}`, deviceId },
    range,
    command: (setpointW) => {
      if (setpointW > 0) return [step('set_charge_kw', { power: setpointW })];
      if (setpointW < 0) return [step('force_discharge_kw', { power: -setpointW })];
      return [step('pause_battery')];
    },
  };
};

const FRONIUS_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  noReadingsCause: 'no_readings',
  appUri: `homey:app:${FRONIUS_APP_ID}`,
  commandLifetime: () => ({ kind: 'persistent' }),
  commandPacing: { kind: 'paced', importRaisingIntervalMs: IMPORT_RAISING_INTERVAL_MS },
  resolve: (device) => {
    const maxW = readMaxPowerW(device);
    if (maxW === undefined) return { kind: 'unavailable', reasonCode: 'battery_max_power_unknown' };
    const range = { minW: -maxW, maxW, stepW: STEP_W, excludeMinW: 0, excludeMaxW: 0 };
    return { kind: 'resolved', actions: froniusActions(device.id, range) };
  },
  resolveTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${FRONIUS_APP_ID}`, deviceId: device.id },
  }),
  // No release before this binding wrote a claim without a target.
  resolveLegacyTarget: (device) => ({
    kind: 'resolved', target: { appUri: `homey:app:${FRONIUS_APP_ID}`, deviceId: device.id },
  }),
  handBack: (target) => [{ deviceId: target.deviceId, actionId: 'reset_control', args: {} }],
};

export const froniusGen24Adapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, FRONIUS_APP_ID, BATTERY_DRIVER_ID),
  homeBatteryBinding: () => FRONIUS_BINDING,
};
