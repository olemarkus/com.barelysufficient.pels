import { resolveDeviceStartPolicy } from '../../../shared-domain/src/settings/deviceStartPolicy.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { resolveDeviceDetailControlState } from './deviceDetail/controlState.ts';
import { isDumpLoadDeviceShape } from './deviceDetail/solarSurplus.ts';
import { isSurplusTrackingDeviceShape } from './deviceDetail/solarSurplusTracking.ts';
import type { SettingsUiDeviceDetailItem } from './deviceUtils.ts';
import { hasResolvedHomeBadges, isDeviceInMeterArea } from './homeBadges.ts';
import { state } from './state.ts';

/**
 * Who starts a device when no Smart task is running on it, as its settings
 * answer it. One answer for two surfaces: the device page states it under
 * Power-limit control, and a Smart task states it for the time after the task,
 * so the two can never disagree.
 *
 * While a task is in progress the task decides whether the device runs,
 * whatever these settings say (owner ruling 2026-09-25).
 *
 * - `starts_when_room`: Power-limit control on. PELS turns the device on
 *   whenever power allows, including after it was turned off outside PELS.
 * - `starts_when_room_unless_off`: the same, with "Leave off until turned on
 *   again", so an outside off holds until the device is turned on.
 * - `runs_on_solar_surplus`: Power-limit control on with a solar-surplus
 *   setting (`Run on solar surplus`, `Charge on solar surplus`, `Match solar
 *   surplus`) the runtime applies, which keeps the device off until the home
 *   exports enough.
 * - `smart_tasks_only`: Power-limit control off with "Only PELS starts this
 *   device". The device stays off, and an outside start is turned off again.
 * - `not_started_by_pels`: Power-limit control off. PELS does not start the
 *   device, and leaves an outside start running.
 */
export type DeviceStartRule =
  | 'starts_when_room'
  | 'starts_when_room_unless_off'
  | 'runs_on_solar_surplus'
  | 'smart_tasks_only'
  | 'not_started_by_pels';

/**
 * `pending` while a setting the rule reads has not loaded (the maps start
 * empty, which reads like a device with nothing turned on); `not_applicable`
 * for a device the rule does not cover: one PELS cannot switch on and off, an
 * unmanaged one, or a battery.
 */
export type DeviceStartRuleRead =
  | { state: 'pending' }
  | { state: 'not_applicable' }
  | { state: 'resolved'; rule: DeviceStartRule };

// The runtime applies a surplus posture only where the surplus pool can fund
// it, and only to a Main-home device (`resolveSurplusOnlyPosture`,
// `resolveSurplusTrackingPosture`): elsewhere the saved opt-in is kept but
// inert, and ordinary capacity control starts the device.
const optsIntoSolarSurplus = (
  device: SettingsUiDeviceDetailItem,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): boolean => state.priceOptimizationSettings[device.id]?.surplusWilling === true
  && state.surplusPoolReachable
  && (isDumpLoadDeviceShape(device, controlState) || isSurplusTrackingDeviceShape(device, controlState));

const resolvePowerLimitedRule = (
  device: SettingsUiDeviceDetailItem,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): DeviceStartRuleRead => {
  if (optsIntoSolarSurplus(device, controlState)) {
    // Only a solar opt-in asks which home the device is in; the meter-area
    // membership loads on its own and starts reading every device as Main.
    if (!hasResolvedHomeBadges()) return { state: 'pending' };
    if (!isDeviceInMeterArea(device.id)) return { state: 'resolved', rule: 'runs_on_solar_surplus' };
  }
  return {
    state: 'resolved',
    rule: state.respectExternalOffMap[device.id] === true ? 'starts_when_room_unless_off' : 'starts_when_room',
  };
};

export const resolveDeviceStartRule = (device: SettingsUiDeviceDetailItem): DeviceStartRuleRead => {
  if (!state.deviceSettingMapsLoaded) return { state: 'pending' };
  if (device.binaryControllable !== true) return { state: 'not_applicable' };
  const controlState = resolveDeviceDetailControlState(device, device.id);
  if (!controlState.isManaged || controlState.isHomeBattery) return { state: 'not_applicable' };
  if (state.controllableMap[device.id] === true) {
    // Only this branch reads the solar opt-in and the surplus pool, which load
    // with the price settings and the device list.
    if (!state.priceOptimizationSettingsLoaded || !state.devicesLoaded) return { state: 'pending' };
    return resolvePowerLimitedRule(device, controlState);
  }
  return {
    state: 'resolved',
    rule: resolveDeviceStartPolicy(state.deviceStartPolicyMap, device.id) === 'pels_only'
      ? 'smart_tasks_only'
      : 'not_started_by_pels',
  };
};

// Every sentence opens with "PELS", so a lead-in can precede it unchanged.
const NOW_SENTENCES: Record<DeviceStartRule, (subject: string) => string> = {
  starts_when_room: (subject) => (
    `PELS turns ${subject} on whenever power allows, even after it was turned off elsewhere.`
  ),
  starts_when_room_unless_off: (subject) => (
    `PELS turns ${subject} on whenever power allows, unless it was turned off elsewhere.`
  ),
  runs_on_solar_surplus: (subject) => `PELS runs ${subject} on your solar surplus.`,
  smart_tasks_only: (subject) => (
    `PELS keeps ${subject} off until a smart task needs it. If it is started elsewhere, PELS turns it off again.`
  ),
  not_started_by_pels: (subject) => (
    `PELS does not start ${subject}. If it is started elsewhere, PELS leaves it running.`
  ),
};

// After a task, one rule says more: with Power-limit control off, the task's
// end applies the device's Power limiting action and keeps applying it until
// the ready-by time, even once the goal is reached
// (`handleDeferredSatisfied`, `setup/appInit/deferredObjectiveLifecycle.ts`).
const AFTER_TASK_SENTENCES: Record<DeviceStartRule, (subject: string) => string> = {
  ...NOW_SENTENCES,
  not_started_by_pels: (subject) => (
    `Until the ready-by time, PELS does what Power limiting is set to for ${subject}, such as turning it off. `
    + 'After that, PELS does not start it, and leaves it running if it is started elsewhere.'
  ),
};

/**
 * The device page's line under Power-limit control, about the device as `it`.
 * While a task is in progress the settings do not decide, so the line says
 * when they do.
 */
export const formatDevicePageStartRule = (rule: DeviceStartRule, taskInProgress: boolean): string => {
  const sentence = NOW_SENTENCES[rule]('it');
  return taskInProgress ? `When no smart task is running, ${sentence}` : sentence;
};

/**
 * A Smart task's "When the task is done" line for its device, or `null` when
 * there is nothing to state: the rule does not cover the device, or a setting
 * it reads has not loaded yet.
 */
export const resolveAfterTaskLine = (device: SettingsUiDeviceDetailItem): string | null => {
  const read = resolveDeviceStartRule(device);
  return read.state === 'resolved'
    ? AFTER_TASK_SENTENCES[read.rule](formatDisplayDeviceName(device.name))
    : null;
};
