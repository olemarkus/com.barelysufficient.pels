import type { AppActionControlTarget } from '../../ports/storageCommand';
import type { HomeyDeviceLike } from '../../utils/types';
import type {
  DeviceAdapter, HomeBatteryActionBinding, HomeBatteryActions, HomeBatteryActionsResolution,
  HomeBatteryTargetResolution,
} from '../deviceAdapter';
import type { DeviceActionStep } from '../flowActionCards';
import { isDeviceOfAppDriver } from '../homeBatteryBinding';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

/*
 * SolaX hybrid inverters over Modbus (`com.msd.inverter.solax`):
 *
 * - The battery is its own device (`solax_modbus_battery`, class `battery`):
 *   `measure_power` and `measure_battery` read the inverter it follows. It
 *   declares no `target_power` and offers no cards.
 * - Control is the inverter device's RAM remote-control cards, one pair per
 *   inverter driver (each for its own `driver_id`):
 *   `set_remote_control_power_ram_<suffix>` (`mode` dropdown, `power` W
 *   -30000..30000, `timeout` s 10..600) and
 *   `disable_remote_control_ram_<suffix>`. G3 inverters offer no RAM cards.
 * - The set card writes remote control to the inverter's RAM only, never its
 *   permanent settings. Mode 4 (Push Power) sets the battery's own power: the
 *   card's `power` is positive to charge, negative to discharge. The inverter
 *   leaves remote control after `timeout` unless the command is sent again;
 *   the app repeats it every half `timeout` until the disable card runs.
 * - The disable card returns the inverter to its own work mode. It is the
 *   hand-back.
 * - Both cards unlock the inverter first only when its `auto_unlock` setting
 *   is on; a write the inverter refuses fails the card.
 * - The battery's power is the inverter's battery power, positive while
 *   charging: Homey's sign.
 *
 * PELS's commands: Push Power at the setpoint, 0 W for a hold, with a 300 s
 * timeout. PELS declares that lifetime and sends the command again every
 * 100 s, so an app restart, which drops the app's own repeat, cannot leave
 * the battery off PELS's command for longer than one timeout.
 *
 * Range: the cards' ±30 kW. The app reports no battery limit; a battery
 * that delivers less teaches PELS its plateau (`lib/battery/batteryVerification.ts`).
 *
 * The battery follows one inverter, chosen in its own pairing, which Homey
 * does not list. So the adapter needs the only SolaX Modbus inverter in the
 * inventory and the only SolaX battery: with two inverters, or two batteries
 * reading one, PELS only watches.
 */
const SOLAX_APP_ID = 'com.msd.inverter.solax';
const BATTERY_DRIVER_ID = 'solax_modbus_battery';

/** The inverter drivers whose battery a SolaX battery device can follow, with their RAM card suffix. */
const INVERTER_CARD_SUFFIXES: ReadonlyMap<string, string | null> = new Map([
  ['solax_modbus_g3', null],
  ['solax_modbus_g4', 'g4'],
  ['solax_modbus_g4_pro', 'g4_pro'],
  ['solax_modbus_x1_vast', 'x1_vast'],
  ['solax_modbus_x3_ies', 'x3_ies'],
  ['solax_modbus_x3_ultra', 'ultra'],
]);

/** RAM remote control's Push Power mode: the battery's own power. */
const PUSH_POWER_MODE = '4';

/** How long one command lasts without a re-send, s. */
export const SOLAX_REMOTE_CONTROL_TIMEOUT_S = 300;

const SOLAX_RANGE_W = 30_000;

type SolaxInverter = { deviceId: string; cardSuffix: string | null };

const findInverters = (devices: readonly HomeyDeviceLike[]): SolaxInverter[] => devices.flatMap((device) => {
  for (const [driverId, cardSuffix] of INVERTER_CARD_SUFFIXES) {
    if (isDeviceOfAppDriver(device, SOLAX_APP_ID, driverId)) return [{ deviceId: device.id, cardSuffix }];
  }
  return [];
});

type InverterResolution =
  | { kind: 'resolved'; deviceId: string; cardSuffix: string }
  | { kind: 'unavailable'; reasonCode: string };

const resolveInverter = (device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): InverterResolution => {
  const batteries = devices.filter((other) => isDeviceOfAppDriver(other, SOLAX_APP_ID, BATTERY_DRIVER_ID));
  if (batteries.some((other) => other.id !== device.id)) {
    return { kind: 'unavailable', reasonCode: 'battery_ambiguous' };
  }
  const inverters = findInverters(devices);
  const [inverter] = inverters;
  if (inverter === undefined) return { kind: 'unavailable', reasonCode: 'inverter_not_found' };
  if (inverters.length > 1) return { kind: 'unavailable', reasonCode: 'inverter_ambiguous' };
  if (inverter.cardSuffix === null) return { kind: 'unavailable', reasonCode: 'inverter_without_remote_control' };
  return { kind: 'resolved', deviceId: inverter.deviceId, cardSuffix: inverter.cardSuffix };
};

const solaxActions = (inverterId: string, cardSuffix: string): HomeBatteryActions => ({
  target: { appUri: `homey:app:${SOLAX_APP_ID}`, deviceId: inverterId },
  range: { minW: -SOLAX_RANGE_W, maxW: SOLAX_RANGE_W, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  command: (setpointW) => [{
    deviceId: inverterId,
    actionId: `set_remote_control_power_ram_${cardSuffix}`,
    args: { mode: PUSH_POWER_MODE, power: setpointW === 0 ? 0 : setpointW, timeout: SOLAX_REMOTE_CONTROL_TIMEOUT_S },
  }],
});

const resolveSolax = (device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): HomeBatteryActionsResolution => {
  const inverter = resolveInverter(device, devices);
  if (inverter.kind === 'unavailable') return inverter;
  return { kind: 'resolved', actions: solaxActions(inverter.deviceId, inverter.cardSuffix) };
};

const resolveSolaxTarget = (
  device: HomeyDeviceLike, devices: readonly HomeyDeviceLike[],
): HomeBatteryTargetResolution => {
  const inverter = resolveInverter(device, devices);
  if (inverter.kind === 'unavailable') return inverter;
  return { kind: 'resolved', target: { appUri: `homey:app:${SOLAX_APP_ID}`, deviceId: inverter.deviceId } };
};

/**
 * The disable card of the inverter a claim recorded, on whichever driver it
 * runs. A recorded inverter missing from the inventory names a card no app
 * lists, so the hand-back fails and the claim stays owed until it is back.
 */
const handBackSteps = (target: AppActionControlTarget, devices: readonly HomeyDeviceLike[]): DeviceActionStep[] => {
  const suffix = findInverters(devices).find((inverter) => inverter.deviceId === target.deviceId)?.cardSuffix;
  const actionId = suffix ? `disable_remote_control_ram_${suffix}` : 'disable_remote_control_ram';
  return [{ deviceId: target.deviceId, actionId, args: {} }];
};

const SOLAX_BINDING: HomeBatteryActionBinding = {
  kind: 'app_actions',
  noReadingsCause: 'no_readings',
  appUri: `homey:app:${SOLAX_APP_ID}`,
  commandLifetime: () => ({ kind: 'expires', lifetimeMs: SOLAX_REMOTE_CONTROL_TIMEOUT_S * 1000 }),
  resolve: resolveSolax,
  resolveTarget: resolveSolaxTarget,
  // No release before this binding wrote a claim without a target.
  resolveLegacyTarget: resolveSolaxTarget,
  handBack: handBackSteps,
};

export const solaxBatteryAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => isDeviceOfAppDriver(device, SOLAX_APP_ID, BATTERY_DRIVER_ID),
  homeBatteryBinding: () => SOLAX_BINDING,
};
