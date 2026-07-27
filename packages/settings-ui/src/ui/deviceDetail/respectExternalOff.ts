import { state } from '../state.ts';
import { RESPECT_EXTERNAL_OFF_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { showToast } from '../toast.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';

/**
 * "Leave off until turned on again" — the per-device opt-in that makes an
 * outside-off action win over PELS's plan until the device is turned on again.
 *
 * Shown only for devices PELS can actually switch: the runtime gate is
 * binary-capability-only, so offering it for a temperature-only device would be
 * a switch that silently does nothing. Disabled — with a visible "why" — while
 * Managed or Power-limit control is off, since the setting only has meaning when
 * PELS controls whether the device runs.
 */

// Queried here rather than in `dom.ts` because these four elements have exactly
// one consumer (this module) and `dom.ts` sits at its 500-line ceiling — the
// same reason `capacity.ts` and `power.ts` hold their own refs.
const q = <T extends Element>(id: string): T | null => document.querySelector<T>(id);
const rowEl = q<HTMLElement>('#device-detail-respect-external-off-row');
const toggleEl = q<HTMLElement & { selected: boolean; disabled: boolean }>(
  '#device-detail-respect-external-off',
);
const powerLimitHintEl = q<HTMLElement>('#device-detail-respect-external-off-power-limit-hint');
const smartTaskHintEl = q<HTMLElement>('#device-detail-respect-external-off-smart-task-hint');

const runSerializedRespectExternalOffWrite = createSerializedAsyncRunner();

/**
 * Strict whole-map read: `null` for anything the runtime would reject, so the
 * caller falls back to its last-known map rather than persisting a corrupt read.
 */
const readStrictBooleanMap = (value: unknown): Record<string, boolean> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === 'boolean')) return null;
  return Object.fromEntries(entries);
};

const hasActiveSmartTask = (deviceId: string): boolean => {
  const entry = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
  if (!entry || !entry.enabled) return false;
  return Number.isFinite(entry.deadlineAtMs) && entry.deadlineAtMs > Date.now();
};

const isPowerLimitControlOn = (deviceId: string): boolean => (
  state.controllableMap[deviceId] === true
);

/**
 * Power-limit-off is the more fundamental blocker, so its hint wins when both
 * apply. The smart-task hint is a WARNING, not a blocker: an explicit off action
 * is meant to beat a smart task, so the switch stays usable and the hint just
 * makes the deadline consequence visible.
 */
const applyRespectExternalOffDisabledState = (
  deviceId: string,
  isManaged: boolean,
  optedIn: boolean,
): void => {
  const powerLimitOff = !isPowerLimitControlOn(deviceId);
  if (toggleEl) {
    // An already-opted-in device stays TOGGLEABLE whatever the current blockers.
    // Otherwise a device that stops qualifying — power metadata disappears,
    // native wiring becomes required, Managed switched off — leaves the user no
    // way to remove the opt-in, and PELS silently starts honouring it again if
    // the device later qualifies. Same escape-hatch rule that keeps the row visible.
    toggleEl.disabled = !optedIn && (powerLimitOff || !isManaged);
  }
  if (powerLimitHintEl) {
    powerLimitHintEl.hidden = !powerLimitOff || !isManaged;
  }
  if (smartTaskHintEl) {
    smartTaskHintEl.hidden = !hasActiveSmartTask(deviceId);
  }
};

/**
 * Sync the row for the open device. Shown when PELS has a binary handle for it,
 * OR when it is already opted in — the escape hatch, so the opt-OUT stays
 * reachable even if the device's shape stops qualifying later.
 *
 * The gate is the control capability, NOT `supportsPower`: a temperature-only or
 * step-only device reports power metadata while having no binary handle, and the
 * runtime detection rejects exactly those (`isBinaryPlanDevice`). Offering the
 * switch there would persist a setting that can never take effect and quietly
 * promise something PELS does not do.
 */
export const syncRespectExternalOffRow = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  if (!rowEl || !toggleEl) return;
  const { deviceId } = params;
  const device = deviceId ? params.getDeviceById(deviceId) : null;
  const controlState = resolveDeviceDetailControlState(device, deviceId ?? '');
  const optedIn = deviceId !== null && state.respectExternalOffMap[deviceId] === true;
  const showRow = deviceId !== null && (device?.controlCapabilityId !== undefined || optedIn);
  rowEl.hidden = !showRow;
  if (!showRow || deviceId === null) {
    toggleEl.selected = false;
    toggleEl.disabled = true;
    if (powerLimitHintEl) {
      powerLimitHintEl.hidden = true;
    }
    if (smartTaskHintEl) {
      smartTaskHintEl.hidden = true;
    }
    return;
  }
  toggleEl.selected = optedIn;
  applyRespectExternalOffDisabledState(deviceId, controlState.isManaged, optedIn);
};

type RespectExternalOffHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshSharedDeviceViews: () => void;
  refreshOpenDeviceDetail: () => void;
};

export const initRespectExternalOffHandler = ({
  getCurrentDetailDeviceId,
  refreshSharedDeviceViews,
  refreshOpenDeviceDetail,
}: RespectExternalOffHandlerDeps): void => {
  toggleEl?.addEventListener('change', () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !toggleEl) return;

    const nextChecked = toggleEl.selected;
    // Serialized like the other multi-edit detail settings: two quick toggles on
    // a slow bridge would otherwise both read the same pre-write map and write
    // independent copies, and the later completion would silently drop the
    // other device's opt-in.
    void runSerializedRespectExternalOffWrite(async () => writeFreshSetting<Record<string, boolean>>({
      key: RESPECT_EXTERNAL_OFF_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update leave-off-until-turned-on device',
      toastMessage: 'Failed to update "Leave off until turned on again".',
      // Use the live map as the fallback so a transient null SDK read does not
      // erase every other device's opt-in.
      fallbackValue: state.respectExternalOffMap,
      // Strict, not shape-only. The RUNTIME reader validates the whole map with
      // `isBooleanMap` and, on a malformed value, keeps its own last-good map —
      // so treating a corrupt read as authoritative here would write a map that
      // silently drops opt-ins the runtime is still honouring. Returning `null`
      // makes `writeFreshSetting` mutate the fallback snapshot instead.
      readFresh: readStrictBooleanMap,
      mutate: (currentMap) => {
        // `true` is the only meaningful value — opting out deletes the key — so
        // this also keeps the stored blob sparse and repairs any stale `false`.
        const nextMap = Object.fromEntries(
          Object.entries(currentMap).filter(([id, value]) => value === true && id !== deviceId),
        );
        if (nextChecked) nextMap[deviceId] = true;
        return nextMap;
      },
      commit: (nextMap) => {
        state.respectExternalOffMap = nextMap;
        refreshSharedDeviceViews();
        refreshOpenDeviceDetail();
        // Turning the setting off releases any hold the runtime is currently
        // honouring, which is not otherwise visible on this screen — say so, so
        // the user knows the device is manageable again.
        if (!nextChecked) void showToast('PELS may now resume this device when power is available.');
      },
      rollback: refreshOpenDeviceDetail,
    }));
  });
};
