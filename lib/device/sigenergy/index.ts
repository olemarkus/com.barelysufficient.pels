import type { HomeBatterySetpointRange } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import type {
  DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions, HomeBatteryActionsResolution,
  HomeBatteryTargetResolution,
} from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * Sigenergy (`com.sigenergy`). PELS manages the `battery` device (class
 * `battery`, `homeBattery`); its `measure_power` is the plant's ESS power,
 * positive while charging: Homey's sign. Control sits on the sibling `plant`
 * device (class `other`): every card below is for `driver_id=plant`, so each
 * step runs on the plant.
 *
 * Cards:
 * - `force_charge_from_grid` (`power` kW, min 0, step 0.1): sets the ESS max
 *   charging limit and remote EMS mode "Charge, grid first", enabling remote
 *   EMS first.
 * - `set_ess_max_discharge_power` (`power` kW, min 0, step 0.1): the ESS max
 *   discharging limit, clamped to the rated power.
 * - `set_remote_ems_control_mode` (`mode` dropdown `1`..`6`: Standby, Max self
 *   consumption, Charge grid first, Charge PV first, Discharge PV first,
 *   Discharge battery first), enabling remote EMS first.
 * - `set_remote_ems` (`state` dropdown `on`/`off`): off hands the plant back
 *   to its own EMS. Some firmware then falls back to Max self consumption
 *   rather than the mode chosen in mySigen; the app cannot restore that, and
 *   neither can PELS.
 * - `remove_ess_charge_limit`, `remove_ess_discharge_limit`: set the limit
 *   back to the rated power, and fail while the rated power is not known.
 *
 * PELS's commands: charge W = `force_charge_from_grid` at W in kW (the app's
 * own "charge at N kW" pairing of limit and mode); discharge W =
 * `set_ess_max_discharge_power` at W in kW, then mode 6, "Discharge, battery
 * first"; hold 0 W = mode 1, Standby. Hand-back turns remote EMS off first,
 * then removes both power limits, which apply even under the plant's own EMS.
 * The removal cards use the app's persisted rated powers. If those are unknown,
 * remote EMS is still off and the owed cleanup retries without guessing a power.
 * A limit the owner had set before PELS is not restored: the app offers no
 * card to read it.
 * Remote EMS stays on until it is turned off, so a command lasts until the
 * next (`persistent`).
 *
 * Range: the plant's rated charging and discharging power, which the app
 * shows as its `ratedChargingPower` and `ratedDischargingPower` settings
 * (`"<n> kW"`). While either is unknown the plant also refuses to remove a
 * limit. New commands wait, but remote EMS off remains available to hand back
 * the plant.
 *
 * The plant is the one `plant` device of the app. With none, or more than one
 * (two systems), or more than one `battery` device (each reads the same plant
 * ESS power, and PELS would drive one plant twice), the battery is
 * unavailable and PELS only watches it.
 */
const SIGENERGY_APP_ID = 'com.sigenergy';
const BATTERY_DRIVER_ID = 'battery';
const PLANT_DRIVER_ID = 'plant';

const REMOTE_EMS_STANDBY = '1';
const REMOTE_EMS_DISCHARGE_BATTERY_FIRST = '6';

/** The cards take kW with a 0.1 kW step. */
const STEP_W = 100;

const toKw = (watts: number): number => Math.round(watts / STEP_W) / (1000 / STEP_W);

/**
 * A rated power setting, `"<n> kW"`, in W on the cards' 0.1 kW grid (rounded
 * down, so PELS never asks for more than the rating); `undefined` while the
 * plant has not reported it.
 */
const readRatedPowerW = (value: unknown): number | undefined => {
  const match = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*kW\s*$/u.exec(value) : null;
  const kw = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const watts = Math.floor(Number((kw * 1000 / STEP_W).toFixed(6))) * STEP_W;
  return Number.isFinite(watts) && watts > 0 ? watts : undefined;
};

const sigenergyActions = (plantId: string, range: HomeBatterySetpointRange): HomeBatteryActions => {
  const step = (actionId: string, args: Readonly<Record<string, unknown>> = {}): DeviceActionStep => (
    { deviceId: plantId, actionId, args }
  );
  return {
    target: { appUri: `homey:app:${SIGENERGY_APP_ID}`, deviceId: plantId },
    range,
    command: (setpointW) => {
      if (setpointW > 0) return [step('force_charge_from_grid', { power: toKw(setpointW) })];
      if (setpointW < 0) {
        return [
          step('set_ess_max_discharge_power', { power: toKw(-setpointW) }),
          step('set_remote_ems_control_mode', { mode: REMOTE_EMS_DISCHARGE_BATTERY_FIRST }),
        ];
      }
      return [step('set_remote_ems_control_mode', { mode: REMOTE_EMS_STANDBY })];
    },
  };
};

const resolveSigenergy = (
  device: HomeyDeviceLike,
  devices: readonly HomeyDeviceLike[],
): HomeBatteryActionsResolution => {
  const batteries = devices.filter((other) => isDeviceOfAppDriver(other, SIGENERGY_APP_ID, BATTERY_DRIVER_ID));
  if (batteries.some((other) => other.id !== device.id)) return { kind: 'unavailable', reasonCode: 'shared_plant' };
  const plants = devices.filter((other) => isDeviceOfAppDriver(other, SIGENERGY_APP_ID, PLANT_DRIVER_ID));
  const [plant] = plants;
  if (plant === undefined) return { kind: 'unavailable', reasonCode: 'plant_not_found' };
  if (plants.length > 1) return { kind: 'unavailable', reasonCode: 'plant_ambiguous' };
  const chargeW = readRatedPowerW(plant.settings.ratedChargingPower);
  const dischargeW = readRatedPowerW(plant.settings.ratedDischargingPower);
  if (chargeW === undefined || dischargeW === undefined) {
    return { kind: 'unavailable', reasonCode: 'plant_rated_power_unknown' };
  }
  const range = { minW: -dischargeW, maxW: chargeW, stepW: STEP_W, excludeMinW: 0, excludeMaxW: 0 };
  return { kind: 'resolved', actions: sigenergyActions(plant.id, range) };
};

const resolvePlantTarget = (devices: readonly HomeyDeviceLike[]): HomeBatteryTargetResolution => {
  const plants = devices.filter((other) => isDeviceOfAppDriver(other, SIGENERGY_APP_ID, PLANT_DRIVER_ID));
  const [plant] = plants;
  if (plant === undefined) return { kind: 'unavailable', reasonCode: 'plant_not_found' };
  if (plants.length > 1) return { kind: 'unavailable', reasonCode: 'plant_ambiguous' };
  return { kind: 'resolved', target: { appUri: `homey:app:${SIGENERGY_APP_ID}`, deviceId: plant.id } };
};

const SIGENERGY_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  noReadingsCause: 'no_readings',
  appUri: `homey:app:${SIGENERGY_APP_ID}`,
  commandLifetime: () => ({ kind: 'persistent' }),
  resolve: resolveSigenergy,
  // Releases before target identities were persisted used the sole plant in
  // the inventory. Retain that upgrade policy for those records only, including
  // a replacement sole plant; current-schema claims keep their recorded target.
  resolveLegacyTarget: (device, devices) => {
    const batteries = devices.filter((other) => isDeviceOfAppDriver(other, SIGENERGY_APP_ID, BATTERY_DRIVER_ID));
    if (batteries.some((other) => other.id !== device.id)) return { kind: 'unavailable', reasonCode: 'shared_plant' };
    return resolvePlantTarget(devices);
  },
  handBack: (target) => [
    { deviceId: target.deviceId, actionId: 'set_remote_ems', args: { state: 'off' } },
    { deviceId: target.deviceId, actionId: 'remove_ess_charge_limit', args: {} },
    { deviceId: target.deviceId, actionId: 'remove_ess_discharge_limit', args: {} },
  ],
  resolveTarget: (_device, devices) => resolvePlantTarget(devices),
};

export const sigenergyAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, SIGENERGY_APP_ID, BATTERY_DRIVER_ID),
  homeBatteryBinding: () => SIGENERGY_BINDING,
};
