import type { TargetDeviceSnapshot } from '../../../types';
import { deviceList, emptyState, refreshButton } from './dom';
import { getSetting, pollSetting, setSetting } from './homey';
import { showToast } from './toast';
import { state } from './state';
import { renderPriorities } from './modes';
import { refreshPlan } from './plan';
import { renderPriceOptimization, savePriceOptimizationSettings } from './prices';

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

export const renderDevices = (devices: TargetDeviceSnapshot[]) => {
  deviceList.innerHTML = '';

  if (!devices.length) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  devices.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'device-row control-row';
    row.setAttribute('role', 'listitem');

    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-row__name';
    nameWrap.textContent = device.name;

    const ctrlLabel = document.createElement('label');
    ctrlLabel.className = 'checkbox-icon';
    ctrlLabel.title = 'Capacity-based control';
    const ctrlInput = document.createElement('input');
    ctrlInput.type = 'checkbox';
    ctrlInput.checked = state.controllableMap[device.id] !== false;
    ctrlInput.addEventListener('change', async () => {
      state.controllableMap[device.id] = ctrlInput.checked;
      await setSetting('controllable_devices', state.controllableMap);
    });
    ctrlLabel.append(ctrlInput);

    const priceOptLabel = document.createElement('label');
    priceOptLabel.className = 'checkbox-icon';
    priceOptLabel.title = 'Price-based control';
    const priceOptInput = document.createElement('input');
    priceOptInput.type = 'checkbox';
    const config = state.priceOptimizationSettings[device.id];
    priceOptInput.checked = config?.enabled || false;
    priceOptInput.addEventListener('change', async () => {
      if (!state.priceOptimizationSettings[device.id]) {
        state.priceOptimizationSettings[device.id] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
      }
      state.priceOptimizationSettings[device.id].enabled = priceOptInput.checked;
      await savePriceOptimizationSettings();
      renderPriceOptimization(state.latestDevices);
    });
    priceOptLabel.append(priceOptInput);

    const controls = document.createElement('div');
    controls.className = 'control-row__inputs';
    controls.append(ctrlLabel, priceOptLabel);

    row.append(nameWrap, controls);
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      const openEvent = new CustomEvent('open-device-detail', { detail: { deviceId: device.id } });
      document.dispatchEvent(openEvent);
    });

    deviceList.appendChild(row);
  });
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
    console.error(error);
    const message = error instanceof Error && error.message
      ? error.message
      : 'Unable to load devices. Check the console for details.';
    await showToast(message, 'warn');
  } finally {
    setBusy(false);
  }
};
