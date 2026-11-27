import { acceptDevicePowerSetup, devicePowerSetupHint, renderDevicePowerSetup } from './devicePowerSetup.ts';
import { render } from 'preact';
import { SetupDevicePicker } from './views/SetupJourney.tsx';
import { currentSetupJourney, trackSetupSave } from './setupJourneyState.ts';
import {
  createGuidedSetupActions, renderGuidedDeviceChoices, readSetupDeviceChoices, retrySetupDeviceReads,
} from './setupDevices.ts';
import { renderSetupGoals } from './setupGoalsRender.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { DEVICE_POWER_SUPPORT_HINT } from './deviceControlAvailability.ts';
import { deviceCardList, emptyState, refreshButton } from './dom.ts';
import { type SettingsUiDevicesPayload } from '../../../contracts/src/settingsUi/devices.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_REFRESH_DEVICES_PATH,
} from '../../../contracts/src/settingsUi/paths.ts';
import {
  callApi,
  captureApiCacheWriteGuard,
  getApiReadModel,
  invalidateApiCacheForAllHomes,
  invalidateApiCacheForScopedHomes,
  primeApiCache,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { isHomeBatteryDeviceId, state } from './state.ts';
import { writeBatteryManaged } from './batteryManaged.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import { renderPriorities } from './modes.ts';
import { refreshPlan } from './plan.ts';
import { renderPriceConfigDevices } from './priceConfig.ts';
import { saveDevicePriceEnabled } from './priceOptimization.ts';
import { createIconToggle } from './components.ts';
import { logSettingsError, logSettingsWarn } from './logging.ts';
import { debouncedSetSetting } from './utils.ts';
import { prefersTouch, setTooltip } from './tooltips.ts';
import {
  getCapacityTitle,
  getRowDisabledReasons,
  type DeviceControlAvailabilityState,
  type RowSwitchTitles,
} from './deviceControlAvailability.ts';
import {
  appendDeviceStateChips,
  createPowerSetupWarning,
  appendRedesignDisabledReasons,
  countManagedInGroup,
  groupDevicesByClass,
  isLimitToggleOn,
  resolveBatteryLimitTitle,
  resolveBatteryRowReasons,
  resolveDeviceManageability,
  resolveDevicePowerSetupPresentation,
  resolveGroupManagedState,
  type DeviceGroup,
} from './deviceListPresentation.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { appendHomeBadge, hasResolvedHomeBadges, refreshHomeBadges } from './homeBadges.ts';
import { applyManagedOptInControlMode } from './deviceDetail/targetPowerConfig.ts';
import {
  applyChargerPhasePresetsRead,
  ensureChargerPhasePresetsRead,
} from './chargerPhasePresets.ts';
import { applyManagedOptInLimit } from './deviceDetail/managedOptInLimit.ts';
import {
  beginManagedControlIntent,
  isCurrentManagedControlIntent,
} from './managedControlIntent.ts';
import {
  MANAGED_DEVICES,
  CONTROLLABLE_DEVICES,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { parseDeviceList } from './deviceListRead.ts';

export const refreshHomeBadgesAndRepaint = (): void => {
  void refreshHomeBadges().then(() => {
    if (!state.devicesLoaded) return;
    renderDevices(state.latestDevices);
    renderPriorities(state.latestDevices);
  });
};

// Whole-home only, deliberately: the two `state.*` solar flags are HOME-level
// gates, so a future scoped read must not funnel through here — a sub-home
// payload assigning them would retract the whole home's solar surfaces. The
// scope-selector PR adds its own scoped reader that discriminates
// `payload.homeScope` before touching any flat field.
export const getTargetDevices = async (): Promise<SettingsUiDeviceListItem[]> => {
  // Badges are additive metadata, never authority for the device list. Fetch
  // them independently so a slow Homey callback cannot blank Devices, Modes,
  // price-device pickers, and Advanced after /ui_devices already resolved.
  const payload = await getApiReadModel<SettingsUiDevicesPayload>(SETTINGS_UI_DEVICES_PATH);
  const devices = parseDeviceList(payload?.devices);
  acceptDevicePowerSetup(payload?.devicePowerSetup);
  // Membership changes arrive as `homes_config` / `device_home_assignments`
  // settings events, which refresh the badges themselves
  // (`refreshHomeBadgesForUi`), and with the runtime's `devices_updated` push,
  // which follows a Homey zone move (`realtime.ts`). Any other device read only
  // fills an index that has not resolved yet.
  if (!hasResolvedHomeBadges()) refreshHomeBadgesAndRepaint();
  state.hasManagedSolarDevice = payload?.hasManagedSolarDevice === true;
  state.hasExhibitedExport = payload?.hasExhibitedExport === true;
  state.surplusPoolReachable = payload?.surplusPoolReachable === true;
  applyChargerPhasePresetsRead(payload?.chargerPhasePresets);
  return devices;
};

const getManagedTitle = (
  isLoadingComplete: boolean,
  supportsManage: boolean,
  nativeWiringRequired: boolean,
): string => {
  if (!isLoadingComplete) return 'Loading...';
  if (!supportsManage) return DEVICE_POWER_SUPPORT_HINT;
  if (nativeWiringRequired) {
    return 'Managed by PELS (open the device page and enable built-in device control first)';
  }
  return 'Managed by PELS';
};

const getPriceTitle = (isLoadingComplete: boolean, manageability: DeviceControlAvailabilityState): string => {
  if (!isLoadingComplete) return 'Loading...';
  if (!manageability.supportsTemperature) return 'Price-based control (temperature devices only)';
  if (manageability.isManaged) return 'Price-based control';
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

const rollbackManagedIntent = (deviceId: string, generation: number, previous: boolean | undefined): void => {
  if (!isCurrentManagedControlIntent(deviceId, generation)) return;
  if (previous === undefined) delete state.managedMap[deviceId];
  else state.managedMap[deviceId] = previous;
  renderDevices(state.latestDevices);
};

const buildManagedToggleHandler = (deviceId: string) => withInitialLoadGuard('managed', async (checked) => {
  if (checked && devicePowerSetupHint(deviceId)) {
    renderDevices(state.latestDevices);
    return;
  }
  const previousManaged = state.managedMap[deviceId];
  const intentGeneration = beginManagedControlIntent(deviceId);
  if (isHomeBatteryDeviceId(deviceId)) {
    const rerender = () => {
      renderDevices(state.latestDevices);
      renderPriorities(state.latestDevices);
    };
    await writeBatteryManaged(deviceId, checked, 'device list', rerender, rerender);
    return;
  }
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  const phaseRead = checked && device?.isEvCharger === true
    ? await ensureChargerPhasePresetsRead()
    : { state: 'resolved' as const, presets: state.chargerPhasePresets };
  if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
  if (phaseRead.state === 'unavailable') {
    await showToast('Could not read the charger wiring. Refresh devices and try again.', 'warn');
    renderDevices(state.latestDevices);
    return;
  }
  // Optimistic UI: update state immediately
  state.managedMap[deviceId] = checked;
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceConfigDevices();
  // Debounced save: coalesces rapid toggles into single save
  try {
    await trackSetupSave(MANAGED_DEVICES, () => debouncedSetSetting(MANAGED_DEVICES, () => ({ ...state.managedMap })));
  } catch (error) {
    rollbackManagedIntent(deviceId, intentGeneration, previousManaged);
    await logSettingsError('Failed to update managed device', error, 'device list');
    await showToastError(error, 'Failed to update managed devices.');
    return;
  }
  if (checked && isCurrentManagedControlIntent(deviceId, intentGeneration)) {
    await applyManagedOptInControlMode(
      deviceId,
      phaseRead.presets,
      () => renderDevices(state.latestDevices),
    );
    // The write above awaited: an owner who has turned Managed back off since
    // must not get Limit switched on for a device they just let go of.
    if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
    await applyManagedOptInLimit(deviceId, () => {
      renderDevices(state.latestDevices);
      renderPriorities(state.latestDevices);
    }, () => isCurrentManagedControlIntent(deviceId, intentGeneration));
  }
});

const buildControllableToggleHandler = (deviceId: string) => withInitialLoadGuard('controllable', async (checked) => {
  // Optimistic UI: update state immediately
  state.controllableMap[deviceId] = checked;
  // Debounced save: coalesces rapid toggles into single save
  try {
    await debouncedSetSetting(CONTROLLABLE_DEVICES, () => ({ ...state.controllableMap }));
  } catch (error) {
    await logSettingsError('Failed to update controllable device', error, 'device list');
    await showToastError(error, 'Failed to update controllable devices.');
  }
});

const buildPriceToggleHandler = (deviceId: string) => withInitialLoadGuard('price opt', async (checked) => {
  try {
    await saveDevicePriceEnabled(deviceId, checked);
    renderPriceConfigDevices();
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

const buildRedesignNameCell = (device: SettingsUiDeviceListItem, offersHomeyEnergy: boolean): HTMLElement => {
  const nameWrap = document.createElement('div');
  nameWrap.className = 'pels-device-card__name device-row__name entity-name';
  const nameText = document.createElement('span');
  nameText.className = 'device-row__title';
  nameText.textContent = formatDisplayDeviceName(device.name);
  if (offersHomeyEnergy) {
    const titleLine = document.createElement('div');
    titleLine.className = 'pels-device-card__title-line';
    titleLine.append(nameText, createPowerSetupWarning(device.id, formatDisplayDeviceName(device.name)));
    nameWrap.append(titleLine);
  } else {
    nameWrap.appendChild(nameText);
  }
  // Which meter this device counts against, before the state chips: structural
  // metadata reads first, the tonal state signals after it.
  appendHomeBadge(nameWrap, device.id);
  appendDeviceStateChips(nameWrap, device);
  return nameWrap;
};

const buildRedesignRowSwitches = (
  device: SettingsUiDeviceListItem,
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
    checked: isLimitToggleOn(device, manageability),
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

const createRedesignDetailButton = (device: SettingsUiDeviceListItem): HTMLElement => {
  const button = document.createElement('md-icon-button');
  button.className = 'pels-device-card__detail-button';
  button.setAttribute('type', 'button');
  const displayName = formatDisplayDeviceName(device.name);
  button.setAttribute('aria-label', `Open settings for ${displayName}`);
  // Touch tap = navigate; the click-triggered tooltip would open at the same
  // moment and strand itself over the detail overlay (see tooltips.ts).
  if (!prefersTouch()) setTooltip(button, `Open settings for ${displayName}`);

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
    dispatchOpenDeviceDetail(device.id, 'top');
  });
  return button;
};

const buildRedesignDeviceRow = (device: SettingsUiDeviceListItem): HTMLElement => {
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

  const setup = resolveDevicePowerSetupPresentation(device, manageability.isManaged);
  const titles: RowSwitchTitles = {
    managed: getManagedTitle(isLoadingComplete, manageability.supportsManage, manageability.nativeWiringRequired),
    limit: resolveBatteryLimitTitle(device)
      ?? getCapacityTitle(isLoadingComplete, manageability, setup.lastResortHint),
    price: getPriceTitle(isLoadingComplete, manageability),
  };

  const nameCell = buildRedesignNameCell(device, setup.offersHomeyEnergy);
  const reasons = getRowDisabledReasons({ isLoadingComplete, manageability, disabled });
  const visibleReasons = { ...reasons,
    managed: setup.managedHint ?? reasons.managed,
    limit: setup.showLimitReason ? reasons.limit : null,
  };
  appendRedesignDisabledReasons(nameCell, isHomeBatteryClassKey(device.deviceClass)
    ? resolveBatteryRowReasons(device, manageability.isManaged, visibleReasons)
    : visibleReasons);

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

const renderSetupDevices = (devices: SettingsUiDeviceListItem[], target: HTMLElement, setupAvailable: boolean) => {
  if (!target.querySelector('.setup-journey__devices')) target.replaceChildren();
  render(SetupDevicePicker({
    choices: readSetupDeviceChoices(devices),
    deviceSetupAvailable: setupAvailable,
    onManaged: (id, value) => {
      void trackSetupSave(`managed:${id}`, () => buildManagedToggleHandler(id)(value))
        .catch((error) => showToastError(error, 'Could not save the device.'))
        .finally(() => { renderDevices(state.latestDevices); notifySetupPathChange(); });
    },
    onOpen: dispatchOpenDeviceDetail,
    onRetry: retrySetupDeviceReads,
  }), target);
};

const refreshGuidedDevices = async (): Promise<boolean> => {
  // A refresh started before a settings write cannot confirm that write.
  while (state.isBusy) await deviceRefreshInProgress;
  return refreshDevices();
};

const guidedSetupActions = createGuidedSetupActions(
  (id, enabled) => buildManagedToggleHandler(id)(enabled), refreshGuidedDevices, readGuidedManagedConfirmation,
);

export const renderDevices = (devices: SettingsUiDeviceListItem[]) => {
  const target = deviceCardList;
  if (!target) return;
  const journey = currentSetupJourney();
  renderDevicePowerSetup(guidedSetupActions);
  const candidates = renderGuidedDeviceChoices(devices, journey);
  const readyDevices = devices.filter(({ id }) => !candidates.has(id));
  emptyState.hidden = true;
  if (journey === 'devices') {
    renderSetupDevices(readyDevices, target, candidates.size > 0);
    return;
  }
  if (journey === 'goals') {
    renderSetupGoals(target, () => renderDevices(state.latestDevices));
    return;
  }
  render(null, target);
  target.replaceChildren();
  if (!readyDevices.length) {
    emptyState.hidden = candidates.size > 0;
    return;
  }

  if (!state.initialLoadComplete) {
    const loadingNotice = document.createElement('div');
    loadingNotice.className = 'plan-chip plan-chip--muted device-loading-notice';
    loadingNotice.textContent = 'Loading device settings...';
    target.appendChild(loadingNotice);
  }

  const fragment = document.createDocumentFragment();
  groupDevicesByClass(readyDevices).forEach((group) => {
    fragment.appendChild(buildDeviceClassCard(group));
  });
  target.appendChild(fragment);
};

const acceptRefreshedDevicePayload = (response: SettingsUiDevicesPayload, devices: SettingsUiDeviceListItem[]) => {
  acceptDevicePowerSetup(response.devicePowerSetup);
  // A whole-home response can re-seed only the bare cache entry.
  invalidateApiCacheForScopedHomes(SETTINGS_UI_DEVICES_PATH);
  const chargerPhasePresets = applyChargerPhasePresetsRead(response.chargerPhasePresets);
  const payload = {
    ...response,
    devices,
    chargerPhasePresets,
    hasManagedSolarDevice: response.hasManagedSolarDevice === true,
    hasExhibitedExport: response.hasExhibitedExport === true,
    surplusPoolReachable: response.surplusPoolReachable === true,
  };
  primeApiCache(SETTINGS_UI_DEVICES_PATH, payload);
  state.hasManagedSolarDevice = payload.hasManagedSolarDevice;
  state.hasExhibitedExport = payload.hasExhibitedExport;
  state.surplusPoolReachable = payload.surplusPoolReachable;
  // These reads bypass getTargetDevices, which normally starts the badge refresh.
  refreshHomeBadgesAndRepaint();
};

const publishRefreshedDevices = async (devices: SettingsUiDeviceListItem[], render = true): Promise<void> => {
  state.latestDevices = devices;
  state.devicesLoaded = true;
  if (render) {
    renderDevices(devices);
    renderPriorities(devices);
    renderPriceConfigDevices();
  }
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices } }));
  invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH);
  await refreshPlan();
};

async function readGuidedManagedConfirmation(
  id: string, isStillWanted: () => boolean,
): Promise<'confirmed' | 'pending' | 'unavailable'> {
  if (state.isBusy) return 'pending';
  const readIsCurrent = captureApiCacheWriteGuard(SETTINGS_UI_DEVICES_PATH);
  const rosterBeforeRead = state.latestDevices;
  try {
    const response = await callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH);
    // A newer refresh may already have published a different roster.
    if (!isStillWanted() || state.isBusy || !readIsCurrent() || rosterBeforeRead !== state.latestDevices) {
      return 'pending';
    }
    const devices = parseDeviceList(response?.devices);
    if (!response.devicePowerSetup) return 'unavailable';
    if (!devices.some((device) => device.id === id && device.managed)) return 'pending';
    acceptRefreshedDevicePayload(response, devices);
    void publishRefreshedDevices(devices).catch((error) => {
      void logSettingsError('Failed to update views after device setup', error, 'device setup');
    });
    return 'confirmed';
  } catch (error) {
    void logSettingsError('Failed to confirm managed device', error, 'device setup');
    return 'unavailable';
  }
}

const runDeviceRefresh = async (options?: { render?: boolean }) => {
  setBusy(true);
  try {
    const response = await callApi<SettingsUiDevicesPayload>('POST', SETTINGS_UI_REFRESH_DEVICES_PATH, {});
    const refreshedDevices = Array.isArray(response?.devices) ? parseDeviceList(response.devices) : null;
    if (refreshedDevices) acceptRefreshedDevicePayload(response, refreshedDevices);
    else invalidateApiCacheForAllHomes(SETTINGS_UI_DEVICES_PATH);

    // If the refresh omits the list, the regular read supplies the device state.
    await publishRefreshedDevices(refreshedDevices ?? await getTargetDevices(), options?.render !== false);
    return refreshedDevices !== null && response?.devicePowerSetup !== undefined;
  } catch (error) {
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');
    const message = error instanceof Error && error.message
      ? error.message
      : 'Unable to load devices. Check Homey logs for details.';
    await showToast(message, 'warn');
    return false;
  } finally {
    setBusy(false);
  }
};

let deviceRefreshInProgress = Promise.resolve(false);

export const refreshDevices = (options?: { render?: boolean }): Promise<boolean> => (
  state.isBusy ? Promise.resolve(false) : (deviceRefreshInProgress = runDeviceRefresh(options))
);
