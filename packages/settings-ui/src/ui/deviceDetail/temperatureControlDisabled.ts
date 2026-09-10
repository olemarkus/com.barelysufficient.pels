import { manualTemperaturePowerHint } from './temperaturePolicy.ts';
import { confirmTemperatureControlChange } from './temperatureControlConfirmation.ts';
import { TEMPERATURE_CONTROL_MODES } from '../../../../contracts/src/settingsKeys.ts';
import {
  readTemperatureControlModes,
  resolveTemperatureControlMode,
  temperatureControlDisabledDevices,
  type TemperatureControlMode,
  type TemperatureControlModes,
} from '../../../../shared-domain/src/settings/temperatureControl.ts';
import { state, hasActiveDeadlineObjective } from '../state.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import type { MdFilledSelectElement } from '../dom.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const rowEl = document.querySelector<HTMLElement>('#device-detail-temperature-control-disabled-row');
const selectEl = document.querySelector<MdFilledSelectElement>('#device-detail-temperature-control-disabled');
const hintEl = document.querySelector<HTMLElement>('#device-detail-temperature-control-hint');
const powerHintEl = document.querySelector<HTMLElement>('#device-detail-temperature-control-power-hint');
const smartTaskHintEl = document.querySelector<HTMLElement>(
  '#device-detail-temperature-control-disabled-smart-task-hint',
);
const runSerializedWrite = createSerializedAsyncRunner();
const pendingSelections = new Map<string, TemperatureControlMode>();

const HINTS: Record<TemperatureControlMode, string> = {
  mode: 'PELS uses the current mode’s target and adjusts it for prices and power limits. '
    + 'If the temperature changes elsewhere, PELS returns it to this target.',
  external: 'PELS keeps new temperature settings. Other power controls work if this device has them. '
    + 'If PELS has lowered the target, it stays lowered until you adjust it.',
  update_mode: 'Temperature changes on the device, in Homey, or from another app or Flow '
    + 'are saved as this device’s target in the current mode. PELS uses saved targets when modes change. '
    + 'Price and solar temperature adjustments are not applied.',
};

export const syncTemperatureControlDisabledRow = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  if (!rowEl || !selectEl) return;
  const device = params.deviceId ? params.getDeviceById(params.deviceId) : null;
  rowEl.hidden = !supportsTemperatureDevice(device);
  if (rowEl.hidden || !params.deviceId) return;
  const id = params.deviceId;
  const selected = pendingSelections.get(id)
    ?? resolveTemperatureControlMode(state.temperatureControlModes, state.temperatureControlDisabledMap, id);
  selectEl.value = selected;
  selectEl.disabled = pendingSelections.has(id);
  const hasTask = hasActiveDeadlineObjective(id);
  for (const value of ['external', 'update_mode']) {
    selectEl.querySelector(`[value="${value}"]`)?.toggleAttribute('disabled', hasTask && selected !== value);
  }
  if (powerHintEl) {
    powerHintEl.hidden = selected === 'mode';
    powerHintEl.textContent = manualTemperaturePowerHint(device);
  }
  if (hintEl) hintEl.textContent = HINTS[selected];
  if (smartTaskHintEl) smartTaskHintEl.hidden = !hasTask || selected === 'external';
};

type HandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
  refreshSharedDeviceViews: () => void;
  refreshOpenDeviceDetail: () => void;
};

export const initTemperatureControlDisabledHandler = (deps: HandlerDeps): void => {
  const saveSelection = (deviceId: string, next: TemperatureControlMode): void => {
    pendingSelections.set(deviceId, next);
    deps.refreshOpenDeviceDetail();
    void runSerializedWrite(async () => writeFreshSetting<TemperatureControlModes>({
      key: TEMPERATURE_CONTROL_MODES,
      context: 'device detail',
      logMessage: 'Failed to update temperature control',
      toastMessage: 'Failed to save how PELS handles temperature.',
      fallbackValue: state.temperatureControlModes,
      readFresh: readTemperatureControlModes,
      mutate: (current) => ({ ...current, [deviceId]: next }),
      commit: (modes) => {
        pendingSelections.delete(deviceId);
        state.temperatureControlModes = modes;
        state.temperatureControlDisabledMap = temperatureControlDisabledDevices(
          modes, state.temperatureControlDisabledMap,
        );
        deps.refreshSharedDeviceViews();
        deps.refreshOpenDeviceDetail();
      },
      rollback: () => {
        pendingSelections.delete(deviceId);
        deps.refreshOpenDeviceDetail();
      },
    }));
  };
  selectEl?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    const next = readTemperatureControlModes({ selected: selectEl.value })?.selected;
    if (!deviceId || !next || (next !== 'mode' && hasActiveDeadlineObjective(deviceId))) {
      deps.refreshOpenDeviceDetail();
      return;
    }
    const previous = resolveTemperatureControlMode(
      state.temperatureControlModes, state.temperatureControlDisabledMap, deviceId,
    );
    if (next === previous) return;
    // Keep the saved selection and its effective controls visible until confirmed.
    deps.refreshOpenDeviceDetail();
    const device = deps.getDeviceById(deviceId);
    if (!device) return;
    if (previous === 'mode' && next !== 'mode'
      && !await confirmTemperatureControlChange(device, next)) return;
    if (deps.getCurrentDetailDeviceId() !== deviceId
      || (next !== 'mode' && hasActiveDeadlineObjective(deviceId))
      || resolveTemperatureControlMode(state.temperatureControlModes, state.temperatureControlDisabledMap, deviceId)
        !== previous) return;
    saveSelection(deviceId, next);
  });
};
