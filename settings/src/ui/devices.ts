import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import { deviceList, emptyState, refreshButton } from './dom';
import { getSetting, pollSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { state } from './state';
import { renderPriorities } from './modes';
import { refreshPlan } from './plan';
import { renderPriceOptimization, savePriceOptimizationSettings } from './prices';
import { createDeviceRow, createCheckboxLabel, renderList } from './components';
import { logSettingsError } from './logging';

const getTargetDevices = async (): Promise<TargetDeviceSnapshot[]> => {
  const snapshot = await getSetting('target_devices_snapshot');
  if (!Array.isArray(snapshot)) {
    return [];
  }
  return snapshot as TargetDeviceSnapshot[];
};

const setBusy = (busy: boolean) => {
  state.isBusy = busy;
  refreshButton.disabled = busy;
};

const buildDeviceRowItem = (device: TargetDeviceSnapshot): HTMLElement => {
  const ctrlCheckbox = createCheckboxLabel({
    title: 'Capacity-based control',
    checked: state.controllableMap[device.id] !== false,
    onChange: async (checked) => {
      state.controllableMap[device.id] = checked;
      try {
        await setSetting('controllable_devices', state.controllableMap);
      } catch (error) {
        await logSettingsError('Failed to update controllable device', error, 'device list');
        await showToastError(error, 'Failed to update controllable devices.');
      }
    },
  });

  const priceOptCheckbox = createCheckboxLabel({
    title: 'Price-based control',
    checked: state.priceOptimizationSettings[device.id]?.enabled || false,
    onChange: async (checked) => {
      if (!state.priceOptimizationSettings[device.id]) {
        state.priceOptimizationSettings[device.id] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
      }
      state.priceOptimizationSettings[device.id].enabled = checked;
      try {
        await savePriceOptimizationSettings();
        renderPriceOptimization(state.latestDevices);
      } catch (error) {
        await logSettingsError('Failed to update price optimization settings', error, 'device list');
        await showToastError(error, 'Failed to update price optimization settings.');
      }
    },
  });

  return createDeviceRow({
    id: device.id,
    name: device.name,
    className: 'control-row',
    controls: [ctrlCheckbox, priceOptCheckbox],
    onClick: () => {
      const openEvent = new CustomEvent('open-device-detail', { detail: { deviceId: device.id } });
      document.dispatchEvent(openEvent);
    },
  });
};

export const renderDevices = (devices: TargetDeviceSnapshot[]) => {
  renderList(deviceList, emptyState, devices, buildDeviceRowItem);
};

export const refreshDevices = async () => {
  if (state.isBusy) return;
  setBusy(true);
  try {
    await setSetting('refresh_target_devices_snapshot', Date.now());
    await pollSetting('target_devices_snapshot', 10, 300);

    const devices = await getTargetDevices();
    state.latestDevices = devices;
    renderDevices(devices);
    renderPriorities(devices);
    renderPriceOptimization(devices);
    await refreshPlan();
  } catch (error) {
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');
    const message = error instanceof Error && error.message
      ? error.message
      : 'Unable to load devices. Check Homey logs for details.';
    await showToast(message, 'warn');
  } finally {
    setBusy(false);
  }
};
