import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { deviceCardList, emptyState, refreshButton } from './dom.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_REFRESH_DEVICES_PATH,
  type SettingsUiDevicesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getApiReadModel, invalidateApiCache, primeApiCache } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { state } from './state.ts';
import { renderPriorities } from './modes.ts';
import { refreshPlan } from './plan.ts';
import { renderPriceOptimization, savePriceOptimizationSettings } from './priceOptimization.ts';
import { createIconToggle } from './components.ts';
import { logSettingsError, logSettingsWarn } from './logging.ts';
import { debouncedSetSetting } from './utils.ts';
import { setTooltip } from './tooltips.ts';
import {
  getRowDisabledReasons,
  type RowSwitchTitles,
} from './deviceControlAvailability.ts';
import {
  appendDeviceStateChips,
  appendRedesignDisabledReasons,
  countManagedInGroup,
  groupDevicesByClass,
  resolveDeviceManageability,
  resolveGroupManagedState,
  type DeviceGroup,
} from './deviceListPresentation.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';

export const getTargetDevices = async (): Promise<TargetDeviceSnapshot[]> => {
  const payload = await getApiReadModel<SettingsUiDevicesPayload>(SETTINGS_UI_DEVICES_PATH);
  return Array.isArray(payload?.devices) ? payload.devices : [];
};

const getManagedTitle = (
  isLoadingComplete: boolean,
  supportsManage: boolean,
  nativeWiringRequired: boolean,
): string => {
  if (!isLoadingComplete) return 'Loading...';
  if (nativeWiringRequired) {
    return 'Managed by PELS (open the device page and enable built-in device control first)';
  }
  if (!supportsManage) return 'Managed by PELS (requires a temperature target or power capability)';
  return 'Managed by PELS';
};

const getCapacityTitle = (params: {
  isLoadingComplete: boolean;
  supportsPower: boolean;
  isManaged: boolean;
}): string => {
  const { isLoadingComplete, supportsPower, isManaged } = params;
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsPower) return 'Power-limit control (requires power measurement or configured load)';
  if (isManaged) return 'Power-limit control';
  return 'Power-limit control (requires Managed by PELS)';
};

const getPriceTitle = (params: {
  isLoadingComplete: boolean;
  supportsTemperature: boolean;
  isManaged: boolean;
}): string => {
  const {
    isLoadingComplete,
    supportsTemperature,
    isManaged,
  } = params;
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsTemperature) return 'Price-based control (temperature devices only)';
  if (isManaged) return 'Price-based control';
  return 'Price-based control (requires Managed by PELS)';
};

const setBusy = (busy: boolean) => {
  state.isBusy = busy;
  refreshButton.disabled = busy;
};

const withInitialLoadGuard = (
  actionLabel: string,
  handler: (checked: boolean) => Promise<void>,
) => async (checked: boolean) => {
  if (!state.initialLoadComplete) {
    await logSettingsWarn(`Blocked ${actionLabel} toggle during initial load`, undefined, 'device list');
    return;
  }
  await handler(checked);
};

const buildManagedToggleHandler = (deviceId: string) => withInitialLoadGuard('managed', async (checked) => {
  // Optimistic UI: update state immediately
  state.managedMap[deviceId] = checked;
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  // Debounced save: coalesces rapid toggles into single save
  try {
    await debouncedSetSetting('managed_devices', () => ({ ...state.managedMap }));
  } catch (error) {
    await logSettingsError('Failed to update managed device', error, 'device list');
    await showToastError(error, 'Failed to update managed devices.');
  }
});

const buildControllableToggleHandler = (deviceId: string) => withInitialLoadGuard('controllable', async (checked) => {
  // Optimistic UI: update state immediately
  state.controllableMap[deviceId] = checked;
  // Debounced save: coalesces rapid toggles into single save
  try {
    await debouncedSetSetting('controllable_devices', () => ({ ...state.controllableMap }));
  } catch (error) {
    await logSettingsError('Failed to update controllable device', error, 'device list');
    await showToastError(error, 'Failed to update controllable devices.');
  }
});

const buildPriceToggleHandler = (deviceId: string) => withInitialLoadGuard('price opt', async (checked) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
  }
  state.priceOptimizationSettings[deviceId].enabled = checked;
  try {
    await savePriceOptimizationSettings();
    renderPriceOptimization(state.latestDevices);
  } catch (error) {
    await logSettingsError('Failed to update price optimization settings', error, 'device list');
    await showToastError(error, 'Failed to update price optimization settings.');
  }
});

const buildRedesignSwitchCell = (
  switchEl: HTMLElement,
  disabled: boolean,
  title: string,
): HTMLElement => {
  const cell = document.createElement('div');
  cell.className = 'pels-device-card__cell';
  if (disabled) {
    cell.classList.add('pels-device-card__cell--disabled');
    const dash = document.createElement('span');
    dash.className = 'pels-device-card__cell-placeholder';
    dash.setAttribute('aria-hidden', 'true');
    dash.textContent = '—';
    setTooltip(dash, title);
    cell.append(switchEl, dash);
  } else {
    cell.appendChild(switchEl);
  }
  return cell;
};

const buildRedesignNameCell = (device: TargetDeviceSnapshot): HTMLElement => {
  const nameWrap = document.createElement('div');
  nameWrap.className = 'pels-device-card__name device-row__name';
  const nameText = document.createElement('span');
  nameText.className = 'device-row__title';
  nameText.textContent = formatDisplayDeviceName(device.name);
  nameWrap.appendChild(nameText);
  appendDeviceStateChips(nameWrap, device);
  return nameWrap;
};

const buildRedesignRowSwitches = (
  device: TargetDeviceSnapshot,
  manageability: ReturnType<typeof resolveDeviceManageability>,
  titles: RowSwitchTitles,
  disabled: { managed: boolean; limit: boolean; price: boolean },
): HTMLElement[] => {
  const managedToggle = createIconToggle({
    iconTemplateId: 'pels-icon-managed',
    title: titles.managed,
    checked: manageability.isManaged,
    disabled: disabled.managed,
    onChange: buildManagedToggleHandler(device.id),
  });
  const limitToggle = createIconToggle({
    iconTemplateId: 'pels-icon-limit',
    title: titles.limit,
    checked: manageability.supportsPower && state.controllableMap[device.id] === true,
    disabled: disabled.limit,
    onChange: buildControllableToggleHandler(device.id),
  });
  const priceToggle = createIconToggle({
    iconTemplateId: 'pels-icon-price',
    title: titles.price,
    checked: manageability.supportsTemperature
      && manageability.isManaged
      && state.priceOptimizationSettings[device.id]?.enabled === true,
    disabled: disabled.price,
    onChange: buildPriceToggleHandler(device.id),
  });
  return [
    buildRedesignSwitchCell(managedToggle, disabled.managed && !manageability.canManage, titles.managed),
    buildRedesignSwitchCell(limitToggle, disabled.limit && !manageability.supportsPower, titles.limit),
    buildRedesignSwitchCell(priceToggle, disabled.price && !manageability.supportsTemperature, titles.price),
  ];
};

const createRedesignDetailButton = (device: TargetDeviceSnapshot): HTMLElement => {
  const button = document.createElement('md-icon-button');
  button.className = 'pels-device-card__detail-button';
  button.setAttribute('type', 'button');
  const displayName = formatDisplayDeviceName(device.name);
  button.setAttribute('aria-label', `Open settings for ${displayName}`);
  setTooltip(button, `Open settings for ${displayName}`);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('class', 'pels-device-card__detail-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'm8.59 16.59 4.58-4.59-4.58-4.59L10 6l6 6-6 6-1.41-1.41z');
  path.setAttribute('fill', 'currentColor');
  icon.appendChild(path);
  button.appendChild(icon);

  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId: device.id } }));
  });
  return button;
};

const buildRedesignDeviceRow = (device: TargetDeviceSnapshot): HTMLElement => {
  const manageability = resolveDeviceManageability(device);
  const isLoadingComplete = state.initialLoadComplete;
  const disabled = {
    managed: !isLoadingComplete || !manageability.canManage,
    limit: !isLoadingComplete || !manageability.supportsPower || !manageability.isManaged,
    price: !isLoadingComplete || !manageability.supportsTemperature || !manageability.isManaged,
  };

  const row = document.createElement('div');
  row.className = 'pels-device-card__row';
  if (disabled.managed && !manageability.canManage) {
    row.classList.add('pels-device-card__row--unmanageable');
  }
  row.dataset.deviceId = device.id;

  const titles: RowSwitchTitles = {
    managed: getManagedTitle(isLoadingComplete, manageability.supportsManage, manageability.nativeWiringRequired),
    limit: getCapacityTitle({
      isLoadingComplete,
      supportsPower: manageability.supportsPower,
      isManaged: manageability.isManaged,
    }),
    price: getPriceTitle({
      isLoadingComplete,
      supportsTemperature: manageability.supportsTemperature,
      isManaged: manageability.isManaged,
    }),
  };

  const nameCell = buildRedesignNameCell(device);
  appendRedesignDisabledReasons(nameCell, getRowDisabledReasons({
    isLoadingComplete,
    manageability,
    disabled,
  }));

  row.append(
    nameCell,
    ...buildRedesignRowSwitches(device, manageability, titles, disabled),
    createRedesignDetailButton(device),
  );
  return row;
};

const buildDeviceClassCard = (group: DeviceGroup): HTMLElement => {
  const card = document.createElement('section');
  card.className = 'pels-surface-card plan-card pels-device-card';
  card.dataset.deviceClass = group.key;

  const counts = countManagedInGroup(group);
  card.dataset.managedState = resolveGroupManagedState(counts);

  const header = document.createElement('header');
  header.className = 'plan-card__header pels-device-card__header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'plan-card__title-wrap';
  const title = document.createElement('h3');
  title.className = 'plan-card__title';
  title.textContent = group.label;
  titleWrap.appendChild(title);

  const chips = document.createElement('div');
  chips.className = 'plan-card__chips';
  if (counts.manageable > 0) {
    const countChip = document.createElement('span');
    countChip.className = 'plan-chip plan-chip--muted pels-device-card__count-chip';
    countChip.textContent = `${counts.managed} of ${counts.total} managed`;
    chips.appendChild(countChip);
  }

  header.append(titleWrap, chips);

  const grid = document.createElement('div');
  grid.className = 'pels-device-card__grid';
  group.devices.forEach((device) => {
    grid.appendChild(buildRedesignDeviceRow(device));
  });

  card.append(header, grid);
  return card;
};

export const renderDevices = (devices: TargetDeviceSnapshot[]) => {
  const target = deviceCardList;
  if (!target) return;
  target.replaceChildren();
  if (!devices.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  if (!state.initialLoadComplete) {
    const loadingNotice = document.createElement('div');
    loadingNotice.className = 'plan-chip plan-chip--muted device-loading-notice';
    loadingNotice.textContent = 'Loading device settings...';
    target.appendChild(loadingNotice);
  }

  const fragment = document.createDocumentFragment();
  groupDevicesByClass(devices).forEach((group) => {
    fragment.appendChild(buildDeviceClassCard(group));
  });
  target.appendChild(fragment);
};

export const refreshDevices = async (options?: { render?: boolean }) => {
  if (state.isBusy) return;
  setBusy(true);
  const shouldRender = options?.render ?? true;
  try {
    const response = await callApi<SettingsUiDevicesPayload>('POST', SETTINGS_UI_REFRESH_DEVICES_PATH, {});
    const hasDevices = Array.isArray(response?.devices);
    if (hasDevices) {
      primeApiCache(SETTINGS_UI_DEVICES_PATH, { devices: response.devices });
    } else {
      invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
    }

    const devices = hasDevices ? response.devices : await getTargetDevices();
    state.latestDevices = devices;
    state.devicesLoaded = true;
    if (shouldRender) {
      renderDevices(devices);
      renderPriorities(devices);
      renderPriceOptimization(devices);
    }
    const devicesUpdated = new CustomEvent('devices-updated', { detail: { devices } });
    document.dispatchEvent(devicesUpdated);
    invalidateApiCache(SETTINGS_UI_PLAN_PATH);
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
