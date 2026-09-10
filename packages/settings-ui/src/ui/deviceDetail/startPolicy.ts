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
 * ON", and it applies either way: with power limiting on it adds a baseline of
 * off to a device that also takes part in capacity limiting; with power limiting
 * off it is the ONLY lever PELS has, which is the case it was built for — a
 * managed load PELS watches but may never command, whose unplanned start is
 * absorbed as background usage while the house sits over its cap.
 *
 * The policy carries its own grant: `resolveDeviceControlPosture` ORs
 * `'pels_only'` into `commandAuthority`, so switching this on is what gives PELS
 * the ability to act. Nothing here needs to consult Power-limit control.
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

/**
 * Show the row for any managed device PELS can switch, OR when the device is
 * already opted in.
 *
 * The second half is the escape hatch every sibling setting keeps: without it a
 * device that stops qualifying — unmanaged now, or its binary handle gone —
 * leaves the owner no way to remove the opt-in, and PELS silently keeps
 * honouring it.
 */
const shouldShowStartPolicyRow = (
  deviceId: string,
  device: SettingsUiDeviceDetailItem | null,
  isManaged: boolean,
): boolean => (
  (isManaged && device?.binaryControllable === true) || isPelsOnly(deviceId)
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
    return;
  }
  toggleEl.selected = optedIn;
  toggleEl.disabled = false;
  if (noTaskHintEl) {
    // A WARNING, not a blocker. A smart task is the only thing that starts a
    // held device, so switching this on for a device with no task means it will
    // not run at all — which is a legitimate thing to want, and the owner should
    // simply be told rather than stopped.
    noTaskHintEl.hidden = !optedIn || hasActiveDeadlineObjective(deviceId);
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
