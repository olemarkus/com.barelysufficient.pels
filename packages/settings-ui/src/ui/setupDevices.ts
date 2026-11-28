import { hasObservedMeasuredPower } from '../../../shared-domain/src/measuredPowerObservedState.ts';
import { h, render } from 'preact';
import {
  devicePowerSetupHint, offersLastResortWithoutMeter, openGuidedDeviceSetup, readDeviceSetupEntries,
  readLastResortSetup,
  type GuidedDeviceSetupActions,
} from './devicePowerSetup.ts';
import { getManagedDisabledReason } from './deviceControlAvailability.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { resolveDeviceClassLabel } from './deviceClassLabels.ts';
import type { DeviceDetailFocus } from './cardActivation.ts';
import { readHomeMembership, refreshHomeScopeAndNotify } from './homeScope.ts';
import { setupSavePending, type SetupJourneyStep } from './setupJourneyState.ts';
import { resolveDeviceManageability } from './deviceListPresentation.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import type { SetupDeviceChoices } from './views/SetupJourney.tsx';
import { DeviceSetupCandidates } from './views/DeviceSetupCandidates.tsx';
import {
  requiresNativeWiringForActivation, supportsTemperatureDevice, supportsPowerDevice, type SettingsUiDeviceListItem,
} from './deviceUtils.ts';
import { isEvChargerDevice, resolveDeviceDetailControlMode, resolveDeviceDetailKind } from './deviceKind.ts';
import { resolveDeviceDetailControlState } from './deviceDetail/controlState.ts';
import { isSurplusTrackingDeviceShape } from './deviceDetail/solarSurplusTracking.ts';
import { isDumpLoadDeviceShape } from './deviceDetail/solarSurplus.ts';
import { hasActiveDeadlineObjective, resolveHomeHasSolar, resolveManagedState, state } from './state.ts';
import { readSetupLimitsInForce } from './setupPathFacts.ts';
import { sleep } from './homey.ts';
import { captureManagedControlIntent } from './managedControlIntent.ts';
import { SURPLUS_TRACKING_LABELS } from '../../../shared-domain/src/solarSurplusTrackingCopy.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import { needsHomeyEnergySetup, HOMEY_ENERGY_SETUP_REASON } from '../../../shared-domain/src/homeyEnergySetup.ts';
import { resolveBatteryManagedHint, BATTERY_WATCH_MANAGED_HINT } from './deviceDetail/batterySection.ts';
import {
  FINISH_CHARGING_SETUP, VEHICLE_CHARGING_SETUP_HINT, vehicleChargingConsentMissing,
} from './chargingSetupFacts.ts';

export type SolarSetupAction = {
  label: string;
  hint: string | null;
  actionLabel: string;
  focus: DeviceDetailFocus;
  configured: boolean;
};

// Discovery describes how to reach existing controls. It never authorizes a
// write or substitutes for the control's own runtime-aligned eligibility gate.
const solarSetupLabel = (device: SettingsUiDeviceListItem): string | null => {
  if (device.isBatteryOrSolar) return null;
  if (supportsTemperatureDevice(device)) return 'Use solar surplus';
  if (resolveDeviceDetailKind(device) === 'ev_charger') return SURPLUS_TRACKING_LABELS.ev_charger;
  const control = resolveDeviceDetailControlState(device, device.id);
  if (isSurplusTrackingDeviceShape(device, control) || resolveDeviceDetailControlMode(device) !== 'default') {
    return SURPLUS_TRACKING_LABELS.stepped;
  }
  return device.binaryControllable ? 'Run on solar surplus' : null;
};

type SolarSetupPrerequisite = { hint: string; focus: DeviceDetailFocus };

const solarSetupPrerequisite = (device: SettingsUiDeviceListItem): SolarSetupPrerequisite | null => {
  const control = resolveDeviceDetailControlState(device, device.id);
  if (requiresNativeWiringForActivation(device)) {
    return { hint: 'Turn on Use built-in device control in Setup.', focus: 'native-control' };
  }
  if (!supportsPowerDevice(device)) return { hint: 'This device needs a power reading.', focus: 'top' };
  if (!control.isManaged) return { hint: 'Turn on Managed by PELS first.', focus: 'managed' };
  if (vehicleChargingConsentMissing(device.id)) {
    return { hint: VEHICLE_CHARGING_SETUP_HINT, focus: 'charging-control' };
  }
  if (supportsTemperatureDevice(device)) {
    return control.canControlTemperature ? null : {
      hint: 'Choose “Return to mode target” under “When the temperature changes outside PELS”.',
      focus: 'temperature-policy',
    };
  }
  if (!isSurplusTrackingDeviceShape(device, control) && !isDumpLoadDeviceShape(device, control)) {
    return {
      hint: resolveDeviceDetailKind(device) === 'ev_charger'
        ? 'Choose “EV 1-phase” or “EV 3-phase” under “Control model” to match the charger’s connection.'
        : 'Choose a suitable control model in Setup.',
      focus: 'control-model',
    };
  }
  if (state.controllableMap[device.id] !== true) {
    return { hint: 'Turn on Power-limit control in Power limiting.', focus: 'power-limit' };
  }
  if (hasActiveDeadlineObjective(device.id)) {
    return { hint: 'Solar-only control can be changed after the active Smart task ends.', focus: 'solar' };
  }
  // Waiting for the first surplus is not a prerequisite the owner can meet; the
  // step's header says it once instead of every card repeating it.
  return null;
};

const solarSetupActionLabel = (prerequisite: SolarSetupPrerequisite | null, label: string): string => {
  if (!prerequisite) return label;
  if (prerequisite.focus === 'charging-control') return FINISH_CHARGING_SETUP;
  if (prerequisite.focus === 'top') return 'Device settings';
  if (prerequisite.focus === 'solar') return 'Solar settings';
  return 'Set up solar control';
};

export const resolveSolarSetupAction = (device: SettingsUiDeviceListItem): SolarSetupAction | null => {
  const label = solarSetupLabel(device);
  if (!label) return null;
  const prerequisite = solarSetupPrerequisite(device);
  return {
    label,
    hint: prerequisite?.hint ?? null,
    actionLabel: solarSetupActionLabel(prerequisite, label),
    focus: prerequisite?.focus ?? 'solar',
    configured: state.priceOptimizationSettings[device.id]?.surplusWilling === true,
  };
};

const formatSetupPower = (kw: number): string => (
  kw < 2 ? `${kw.toFixed(2).replace(/\.?0+$/, '')} kW` : `${kw.toFixed(1)} kW`
);

// With no limit in force nothing lowers a charger, so its hint names what PELS
// does for it instead: charge on solar surplus where the home has solar, and by
// a set time through a Smart task. Until the limits are read, and while one is
// in force, the limit line stands.
const powerDeviceHint = (device: SettingsUiDeviceListItem): string => {
  if (readSetupLimitsInForce() !== false || !isEvChargerDevice(device)) {
    return 'PELS may lower or pause this device.';
  }
  return resolveHomeHasSolar()
    ? 'PELS can charge it on solar surplus or by a set time.'
    : 'PELS can charge it by a set time.';
};

const setupDeviceHint = (
  device: SettingsUiDeviceListItem,
  manageability: ReturnType<typeof resolveDeviceManageability>,
): string | null => {
  if (manageability.nativeWiringRequired) return 'Enable device control in Setup.';
  // A battery is neither paused nor set to a temperature: say what its device page's Managed says.
  if (isHomeBatteryClassKey(device.deviceClass)) {
    return manageability.supportsPower ? resolveBatteryManagedHint() : BATTERY_WATCH_MANAGED_HINT;
  }
  const lastResort = readLastResortSetup(device.id);
  if (lastResort) return lastResort.hint;
  if (needsHomeyEnergySetup(device)) {
    return offersLastResortWithoutMeter(device.id)
      ? 'Choose how to set up power limiting.'
      : `${HOMEY_ENERGY_SETUP_REASON} if its draw stays steady while on.`;
  }
  if (manageability.supportsPower) return powerDeviceHint(device);
  return manageability.supportsTemperature
    ? 'PELS may adjust its temperature.' : 'PELS needs a power reading to limit this device.';
};

export const retrySetupDeviceReads = (): void => {
  if (state.devicesReadState === 'unavailable') document.dispatchEvent(new Event('request-load-devices'));
  if (readHomeMembership().state === 'unavailable') void refreshHomeScopeAndNotify();
};

export const readGuidedDeviceChoices = (devices: SettingsUiDeviceListItem[], firstRun: boolean) => {
  if (!state.initialLoadComplete || state.devicesReadState === 'unavailable') return [];
  const roster = new Map(devices.map((device) => [device.id, device]));
  return readDeviceSetupEntries().filter((entry) => {
    if (typeof entry.homeId !== 'string' || (firstRun && entry.homeId !== MAIN_HOME_ID) || entry.usedBy) return false;
    const device = roster.get(entry.id);
    if (!device) return true;
    const manageability = resolveDeviceManageability(device);
    if (manageability.isManaged || manageability.nativeWiringRequired) return false;
    const offersMeterOrLastResort = entry.lastResortAvailable || entry.sources.some(
      ({ state: sourceState }) => sourceState === 'selectable' || sourceState === 'managed',
    );
    if (needsHomeyEnergySetup(device) && !manageability.supportsTemperature
      && !readLastResortSetup(device.id) && offersMeterOrLastResort) return true;
    return !manageability.canManage && (!manageability.supportsManage || devicePowerSetupHint(device.id) !== null);
  }).map(({ id, name, configured, binarySwitchId, binarySwitches, lastResortMaximumW }) => ({
    id, name: formatDisplayDeviceName(name),
    suggested: roster.has(id) || configured || Boolean(binarySwitchId || binarySwitches?.length || lastResortMaximumW),
  }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
};

export const renderGuidedDeviceChoices = (devices: SettingsUiDeviceListItem[], journey: SetupJourneyStep | null) => {
  const candidates = journey === 'goals' ? [] : readGuidedDeviceChoices(devices, journey === 'devices');
  const mount = document.getElementById('device-setup-candidates');
  if (mount) {
    mount.hidden = candidates.length === 0;
    render(candidates.length
      ? h(DeviceSetupCandidates, { devices: candidates, onOpen: openGuidedDeviceSetup }) : null, mount);
  }
  return new Set(candidates.map(({ id }) => id));
};

type ReadManagedConfirmation = (
  id: string, isStillWanted: () => boolean,
) => Promise<'confirmed' | 'pending' | 'unavailable'>;

const hasManagedReadback = (id: string): boolean => (
  state.latestDevices.some((device) => device.id === id && device.managed)
);

const waitForManagedReadback = async (
  id: string, isStillWanted: () => boolean, read: ReadManagedConfirmation,
): Promise<boolean> => {
  let waiting = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canConfirm = () => waiting && isStillWanted();
  const poll = async (): Promise<boolean> => {
    for (let delay = 250; canConfirm(); delay = Math.min(delay * 2, 1_000)) {
      await sleep(delay);
      if (!canConfirm()) return false;
      if (hasManagedReadback(id)) return true;
      const result = await read(id, canConfirm);
      if (result !== 'pending') return canConfirm() && result === 'confirmed';
    }
    return false;
  };
  // The runtime batches Managed writes before refreshing. Leave room for that
  // work, while bounding the dialog even if a read callback never arrives.
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { waiting = false; resolve(false); }, 8_000);
  });
  try {
    return await Promise.race([poll(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const createGuidedManageAction = (
  setManaged: (deviceId: string, enabled: boolean) => Promise<void>, refresh: () => Promise<boolean>,
  readManagedConfirmation: ReadManagedConfirmation,
) => async (deviceId: string, enabled: boolean): Promise<boolean> => {
  if (!enabled) {
    if (resolveManagedState(deviceId)) await setManaged(deviceId, false);
    return !resolveManagedState(deviceId);
  }
  const device = state.latestDevices.find(({ id }) => id === deviceId);
  if (!device || !resolveDeviceManageability(device).canManage || !state.initialLoadComplete) return false;

  const write = resolveManagedState(deviceId) ? undefined : setManaged(deviceId, true);
  const isCurrent = captureManagedControlIntent(deviceId);
  const isStillWanted = () => isCurrent() && resolveManagedState(deviceId);
  await write;
  if (!isStillWanted() || !await refresh() || !isStillWanted()) return false;
  return hasManagedReadback(deviceId) || waitForManagedReadback(deviceId, isStillWanted, readManagedConfirmation);
};

const guidedManagedDisabledReason = (id: string): string | null => {
  const device = state.latestDevices.find((entry) => entry.id === id);
  if (!device) return 'PELS could not find this device in the refreshed device list.';
  const { supportsManage, nativeWiringRequired } = resolveDeviceManageability(device);
  return getManagedDisabledReason(state.initialLoadComplete, supportsManage, nativeWiringRequired);
};

export const createGuidedSetupActions = (
  setManaged: (deviceId: string, enabled: boolean) => Promise<void>, refresh: () => Promise<boolean>,
  readManagedConfirmation: ReadManagedConfirmation,
): GuidedDeviceSetupActions => ({
  refresh,
  manage: createGuidedManageAction(setManaged, refresh, readManagedConfirmation),
  managedDisabledReason: guidedManagedDisabledReason,
  offersHomeyEnergy: (id) => needsHomeyEnergySetup(state.latestDevices.find((device) => device.id === id)),
  simulation: () => state.dryRun,
});

export const readSetupDeviceChoices = (devices: SettingsUiDeviceListItem[]): SetupDeviceChoices => {
  const membership = readHomeMembership();
  if (state.devicesReadState === 'unavailable') return { state: 'unavailable' };
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return { state: 'ready', devices: devices
    .filter((device) => (membership.membershipByDeviceId[device.id] ?? 'main') === 'main')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .flatMap((device) => {
      const manageability = resolveDeviceManageability(device);
      if (!manageability.supportsManage) return [];
      return [{
        id: device.id,
        name: formatDisplayDeviceName(device.name),
        detail: [
          resolveDeviceClassLabel(device.deviceClass),
          device.zoneName,
          hasObservedMeasuredPower(device) ? formatSetupPower(device.measuredPowerKw) : null,
        ].filter(Boolean).join(' · '),
        managed: manageability.isManaged,
        disabled: !state.initialLoadComplete || !manageability.canManage || setupSavePending(),
        hint: setupDeviceHint(device, manageability),
      }];
    }) };
};

