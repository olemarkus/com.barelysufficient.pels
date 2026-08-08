import { TEMPERATURE_CONTROL_DISABLED_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
import { state, hasActiveDeadlineObjective } from '../state.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const q = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);
const rowEl = q<HTMLElement>('#device-detail-temperature-control-disabled-row');
const toggleEl = q<HTMLElement & { selected: boolean; disabled: boolean }>(
  '#device-detail-temperature-control-disabled',
);
const smartTaskHintEl = q<HTMLElement>('#device-detail-temperature-control-disabled-smart-task-hint');
const runSerializedWrite = createSerializedAsyncRunner();
const pendingSelectionByDeviceId = new Map<string, boolean>();

const readStrictBooleanMap = (value: unknown): Record<string, boolean> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([deviceId, entry]) => deviceId.length > 0 && typeof entry === 'boolean')) return null;
  return Object.fromEntries(entries.filter(([, entry]) => entry === true));
};

const withDeviceSelection = (
  currentMap: Record<string, boolean>,
  deviceId: string,
  selected: boolean,
): Record<string, boolean> => {
  const nextMap = Object.fromEntries(
    Object.entries(currentMap).filter(([id, value]) => value === true && id !== deviceId),
  );
  if (selected) nextMap[deviceId] = true;
  return nextMap;
};

const overlayPendingSelections = (persistedMap: Record<string, boolean>): Record<string, boolean> => {
  let nextMap = persistedMap;
  pendingSelectionByDeviceId.forEach((selected, deviceId) => {
    nextMap = withDeviceSelection(nextMap, deviceId, selected);
  });
  return nextMap;
};

const hasActiveSmartTask = (deviceId: string): boolean => hasActiveDeadlineObjective(deviceId);

const canOfferTemperatureControlSwitch = (
  device: SettingsUiDeviceDetailItem | null,
  selected: boolean,
): boolean => {
  if (selected) return true;
  if (!supportsTemperatureDevice(device)) return false;
  return device?.capabilities?.includes('onoff') === true
    || device?.controlCapabilityId !== undefined;
};

export const syncTemperatureControlDisabledRow = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  if (!rowEl || !toggleEl) return;
  const { deviceId } = params;
  const device = deviceId ? params.getDeviceById(deviceId) : null;
  const persistedSelection = deviceId !== null && state.temperatureControlDisabledMap[deviceId] === true;
  const pendingSelection = deviceId === null ? undefined : pendingSelectionByDeviceId.get(deviceId);
  const selected = pendingSelection ?? persistedSelection;
  const showRow = deviceId !== null && canOfferTemperatureControlSwitch(device, selected);
  rowEl.hidden = !showRow;
  if (!showRow || deviceId === null) {
    toggleEl.selected = false;
    toggleEl.disabled = true;
    if (smartTaskHintEl) smartTaskHintEl.hidden = true;
    return;
  }
  const blockedBySmartTask = !selected && hasActiveSmartTask(deviceId);
  toggleEl.selected = selected;
  toggleEl.disabled = pendingSelection !== undefined || blockedBySmartTask;
  if (smartTaskHintEl) smartTaskHintEl.hidden = !blockedBySmartTask;
};

type HandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  refreshSharedDeviceViews: () => void;
  refreshOpenDeviceDetail: () => void;
};

export const initTemperatureControlDisabledHandler = (deps: HandlerDeps): void => {
  toggleEl?.addEventListener('change', () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !toggleEl) return;
    const nextSelected = toggleEl.selected;
    const previousSelected = state.temperatureControlDisabledMap[deviceId] === true;
    const persistedFallback = state.temperatureControlDisabledMap;
    pendingSelectionByDeviceId.set(deviceId, nextSelected);
    state.temperatureControlDisabledMap = withDeviceSelection(
      state.temperatureControlDisabledMap,
      deviceId,
      nextSelected,
    );
    deps.refreshOpenDeviceDetail();
    void runSerializedWrite(async () => writeFreshSetting<Record<string, boolean>>({
      key: TEMPERATURE_CONTROL_DISABLED_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update disabled temperature control device',
      toastMessage: 'Failed to update "Disable temperature control".',
      fallbackValue: persistedFallback,
      readFresh: readStrictBooleanMap,
      mutate: (currentMap) => withDeviceSelection(currentMap, deviceId, nextSelected),
      commit: (nextMap) => {
        pendingSelectionByDeviceId.delete(deviceId);
        state.temperatureControlDisabledMap = overlayPendingSelections(nextMap);
        deps.refreshSharedDeviceViews();
        deps.refreshOpenDeviceDetail();
      },
      rollback: () => {
        pendingSelectionByDeviceId.delete(deviceId);
        state.temperatureControlDisabledMap = overlayPendingSelections(withDeviceSelection(
          state.temperatureControlDisabledMap,
          deviceId,
          previousSelected,
        ));
        deps.refreshOpenDeviceDetail();
      },
    }));
  });
};
