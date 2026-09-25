import { state, hasActiveDeadlineObjective } from '../state.ts';
import { DEVICE_START_POLICIES } from '../../../../contracts/src/settingsKeys.ts';
import {
  isDeviceStartPolicyMap,
  resolveDeviceStartPolicy,
  type DeviceStartPolicy,
} from '../../../../shared-domain/src/settings/deviceStartPolicy.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { syncRespectExternalOffRow } from './respectExternalOff.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';

/**
 * "Only PELS starts this device" — the per-device opt-in that gives a device a
 * standing OFF baseline, so a start from anywhere else is turned back off.
 *
 * ## The complement of its sibling, not its substitute
 *
 * `respectExternalOff.ts` answers "who may turn this device OFF" and needs
 * Power-limit control on to mean anything. This one answers "who may turn it
 * ON", and it applies only with power limiting OFF, where it is the only lever
 * PELS has — the case it was built for: a managed load PELS watches but may
 * never command, whose unplanned start is absorbed as background usage while
 * the house sits over its cap. With power limiting on PELS already decides when
 * the device runs, and the runtime does not apply the policy
 * (`resolveStartPolicyInForce`, owner ruling 2026-09-25), so the row is hidden
 * for a device that is not opted in. The stored choice is left as it is and
 * applies again if power limiting goes off, which a Flow can do
 * (`disable_device_capacity_control`), so an opted-in device keeps the row,
 * says the setting is paused, and can still be switched off.
 *
 * The policy carries its own grant: `resolveDeviceControlPosture` ORs
 * `'pels_only'` into `commandAuthority`, so switching this on is what gives PELS
 * the ability to act.
 *
 * Shown only for managed devices PELS can actually switch: without a binary
 * handle there is nothing to turn back off, and offering the switch would
 * persist a setting that can never take effect.
 */

// Queried here rather than in `dom.ts` for the same reason `respectExternalOff`
// holds its own refs: these three elements have exactly one consumer and
// `dom.ts` sits at its 500-line ceiling.
const q = <T extends Element>(id: string): T | null => document.querySelector<T>(id);
const rowEl = q<HTMLElement>('#device-detail-start-policy-row');
const toggleEl = q<HTMLElement & { selected: boolean; disabled: boolean }>(
  '#device-detail-start-policy',
);
const noTaskHintEl = q<HTMLElement>('#device-detail-start-policy-no-task-hint');
const pausedHintEl = q<HTMLElement>('#device-detail-start-policy-paused-hint');

const runSerializedStartPolicyWrite = createSerializedAsyncRunner();

/**
 * Strict whole-map read: `null` for anything the runtime would reject, so
 * `writeFreshSetting` falls back to its last-known map rather than merging into
 * a corrupt read.
 *
 * The predicate is the KEY'S OWNER's, not a copy of it. A mirrored guard here
 * would go stale the moment the third policy value the owner module already
 * anticipates lands: this reader would reject every map containing it and
 * silently drop back to the in-memory snapshot, disabling the cross-session
 * freshness protection the serialized writer exists for, with no error.
 */
const readStrictStartPolicyMap = (value: unknown): Record<string, DeviceStartPolicy> | null => (
  isDeviceStartPolicyMap(value) ? { ...value } : null
);

// Through the owner's resolver, so the absence default lives in exactly one place.
const isPelsOnly = (deviceId: string): boolean => (
  resolveDeviceStartPolicy(state.deviceStartPolicyMap, deviceId) === 'pels_only'
);

const isPowerLimitControlOn = (deviceId: string): boolean => state.controllableMap[deviceId] === true;

/**
 * Show the row while Power-limit control is off, for any managed device PELS can
 * switch, OR when the device is already opted in.
 *
 * The opted-in half is the escape hatch every sibling setting keeps: without it
 * a device that stops qualifying (unmanaged now, its binary handle gone, or
 * power limiting on) leaves the owner no way to remove the opt-in, and PELS
 * silently starts honouring it again once the device qualifies.
 */
const shouldShowStartPolicyRow = (
  deviceId: string,
  device: SettingsUiDeviceDetailItem | null,
  isManaged: boolean,
): boolean => (
  (!isPowerLimitControlOn(deviceId) && isManaged && device?.binaryControllable === true)
  || isPelsOnly(deviceId)
);

/** Sync the row for the open device. */
export const syncStartPolicyRow = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  if (!rowEl || !toggleEl) return;
  const { deviceId } = params;
  const device = deviceId ? params.getDeviceById(deviceId) : null;
  const controlState = resolveDeviceDetailControlState(device, deviceId ?? '');
  const optedIn = deviceId !== null && isPelsOnly(deviceId);
  const showRow = deviceId !== null
    && shouldShowStartPolicyRow(deviceId, device, controlState.isManaged);
  rowEl.hidden = !showRow;
  if (!showRow || deviceId === null) {
    toggleEl.selected = false;
    toggleEl.disabled = true;
    if (noTaskHintEl) noTaskHintEl.hidden = true;
    if (pausedHintEl) pausedHintEl.hidden = true;
    return;
  }
  toggleEl.selected = optedIn;
  toggleEl.disabled = false;
  // Only reachable opted in: the row is hidden otherwise while power limiting is on.
  const paused = isPowerLimitControlOn(deviceId);
  if (pausedHintEl) pausedHintEl.hidden = !paused;
  if (noTaskHintEl) {
    // A WARNING, not a blocker. A smart task is the only thing that starts a
    // held device, so switching this on for a device with no task means it will
    // not run at all — which is a legitimate thing to want, and the owner should
    // simply be told rather than stopped. Not while paused: PELS then starts the
    // device on capacity, so the warning would be false.
    noTaskHintEl.hidden = !optedIn || paused || hasActiveDeadlineObjective(deviceId);
  }
};

type StartPolicyHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshSharedDeviceViews: () => void;
  refreshOpenDeviceDetail: () => void;
};

export const initStartPolicyHandler = ({
  getCurrentDetailDeviceId,
  refreshSharedDeviceViews,
  refreshOpenDeviceDetail,
}: StartPolicyHandlerDeps): void => {
  toggleEl?.addEventListener('change', () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !toggleEl) return;

    const nextPolicy: DeviceStartPolicy = toggleEl.selected ? 'pels_only' : 'unrestricted';
    // Serialized like the other multi-edit detail settings: two quick toggles on
    // a slow bridge would otherwise both read the same pre-write map and write
    // independent copies, and the later completion would drop the other device's
    // policy.
    void runSerializedStartPolicyWrite(async () => writeFreshSetting<Record<string, DeviceStartPolicy>>({
      key: DEVICE_START_POLICIES,
      context: 'device detail',
      logMessage: 'Failed to update device start policy',
      toastMessage: 'Failed to update "Only PELS starts this device".',
      // The live map as the fallback, so a transient null SDK read does not
      // erase every other device's policy.
      fallbackValue: state.deviceStartPolicyMap,
      readFresh: readStrictStartPolicyMap,
      mutate: (currentMap) => ({ ...currentMap, [deviceId]: nextPolicy }),
      commit: (nextMap) => {
        state.deviceStartPolicyMap = nextMap;
        refreshSharedDeviceViews();
        refreshOpenDeviceDetail();
      },
    }));
  });
};

/**
 * The two rows that answer "who may switch this device": the off side
 * ("Leave off until turned on again") and the on side ("Only PELS starts this
 * device"). They are complements — one applies when Power-limit control is on,
 * the other when it is off — so they are synced together and read as one
 * concern at the call site.
 */
export const syncDevicePolicyRows = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  syncRespectExternalOffRow(params);
  syncStartPolicyRow(params);
};
