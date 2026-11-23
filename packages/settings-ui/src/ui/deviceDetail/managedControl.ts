import { resolveDeviceDetailKind } from '../deviceKind.ts';
import { DEVICE_POWER_SUPPORT_HINT } from '../deviceControlAvailability.ts';
import { resolveBatteryManagedHint, BATTERY_WATCH_MANAGED_HINT } from './batterySection.ts';
import type { resolveDeviceDetailControlState } from './controlState.ts';
import {
  HOMEY_ENERGY_SETUP_DOCS_URL, HOMEY_ENERGY_SETUP_HINT, needsHomeyEnergySetup,
} from '../../../../shared-domain/src/homeyEnergySetup.ts';
import {
  devicePowerSetupAlternative, devicePowerSetupHint, devicePowerSetupWarning, isDeviceReservedBySetup,
  readDevicePowerSetupDetail,
  renderDeviceDetailPowerSetup, resolveLastResortHint,
} from '../devicePowerSetup.ts';
import {
  deviceDetailControllable,
  deviceDetailManaged,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { isHomeBatteryDeviceId, state, type SettingsUiDeviceView } from '../state.ts';
import { writeBatteryManaged } from '../batteryManaged.ts';
import { showToast } from '../toast.ts';
import { ensureChargerPhasePresetsRead } from '../chargerPhasePresets.ts';
import {
  beginManagedControlIntent,
  isCurrentManagedControlIntent,
} from '../managedControlIntent.ts';
import {
  createSerializedAsyncRunner,
  readRecordSettingStrict,
  writeFreshSetting,
} from './settingsWrite.ts';
import { applyManagedOptInControlMode } from './targetPowerConfig.ts';
import { applyManagedOptInLimit } from './managedOptInLimit.ts';
import { refreshDeviceSchedules } from './temporaryCard.ts';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
} from '../../../../shared-domain/src/settings/settingsKeys.ts';

export const renderManagedControl = (
  device: SettingsUiDeviceView | null,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): void => {
  const setupHint = device ? devicePowerSetupHint(device.id) : null;
  const reservedCompanion = device ? isDeviceReservedBySetup(device.id) : false;
  if (deviceDetailManaged) {
    deviceDetailManaged.selected = controlState.isManaged && !reservedCompanion;
    deviceDetailManaged.disabled = !controlState.canManageDevice || reservedCompanion
      || (!controlState.isManaged && setupHint !== null);
  }
  renderManagedPowerSetup(device, resolveManagedHint(device, controlState), setupHint, controlState.isManaged);
};

function renderManagedPowerSetup(
  device: SettingsUiDeviceView | null, defaultHint: string, setupHint: string | null, managed: boolean,
): void {
  const setup = device ? readDevicePowerSetupDetail(device.id) : undefined;
  const offersHomeyEnergy = needsHomeyEnergySetup(device) && !setup?.lastResort;
  const warning = device ? devicePowerSetupWarning(device.id) : null;
  const hint = setupHint ?? warning ?? resolveLastResortHint(setup?.lastResort, managed)
    ?? withPowerSetupAlternative(device, defaultHint, offersHomeyEnergy);
  renderManagedSetupHint(hint, offersHomeyEnergy || warning !== null);
  renderDeviceDetailPowerSetup(device?.id);
  renderHomeyEnergySetupLink(offersHomeyEnergy && !setup?.socketPending);
}

/** A device waiting for a power reading also learns what External sensors offers it. */
function withPowerSetupAlternative(
  device: SettingsUiDeviceView | null, hint: string, offersHomeyEnergy: boolean,
): string {
  const alternative = offersHomeyEnergy && device ? devicePowerSetupAlternative(device.id) : null;
  return alternative ? `${hint} ${alternative}` : hint;
}

function renderManagedSetupHint(text: string, warning: boolean): void {
  const hint = document.getElementById('device-detail-managed-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.dataset.tone = warning ? 'warning' : 'neutral';
}

function renderHomeyEnergySetupLink(visible: boolean): void {
  const energySetupLink = document.getElementById('device-detail-homey-energy-setup');
  if (energySetupLink) {
    energySetupLink.hidden = !visible;
    energySetupLink.setAttribute('href', HOMEY_ENERGY_SETUP_DOCS_URL);
    energySetupLink.setAttribute('target', '_blank');
    energySetupLink.setAttribute('rel', 'noopener noreferrer');
  }
}

const resolveManagedHint = (
  device: SettingsUiDeviceView | null,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): string => {
  if (controlState.isHomeBattery) {
    return controlState.isDrivableBattery ? resolveBatteryManagedHint() : BATTERY_WATCH_MANAGED_HINT;
  }
  if (device && needsHomeyEnergySetup(device)) return HOMEY_ENERGY_SETUP_HINT;
  if (!controlState.supportsPower && !controlState.supportsTemperature) return DEVICE_POWER_SUPPORT_HINT;
  // An unmanaged charger's page hides its Charging and Power limiting cards
  // (chargingCard.ts), so this switch names what they hold.
  if (!controlState.isManaged && resolveDeviceDetailKind(device) === 'ev_charger') {
    return 'Turn on to set how this charger charges and how PELS limits it.';
  }
  return 'Include this device in modes and optimization plans.';
};

const runSerializedManagedWrite = createSerializedAsyncRunner();

export function initDeviceDetailManagedControlHandlers(
  getCurrentDetailDeviceId: () => string | null,
  refreshCurrentDeviceControlStates: () => void,
  refreshOpenDeviceDetail: () => void,
  refreshSharedDeviceViews: () => void,
) {
  deviceDetailControllable?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailControllable) return;

    const nextChecked = deviceDetailControllable.selected;
    await writeFreshSetting<Record<string, boolean>>({
      key: CONTROLLABLE_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update controllable device',
      toastMessage: 'Failed to update controllable device.',
      // Use the live controllable-map snapshot as the fallback so a
      // transient null or non-object SDK read does not erase entries for
      // other devices.
      fallbackValue: state.controllableMap,
      readFresh: readRecordSettingStrict<boolean>,
      mutate: (currentMap) => ({
        ...currentMap,
        [deviceId]: nextChecked,
      }),
      commit: (nextMap) => {
        state.controllableMap = nextMap;
        renderDevices(state.latestDevices);
        // Other controls in this panel gate on Power-limit control — the
        // "Leave off until turned on again" switch is disabled with a hint
        // naming it as the prerequisite. `renderDevices` only redraws the LIST,
        // so without this the user follows the hint, turns Power-limit control
        // on, and the switch they were sent to stays disabled until they
        // reopen the panel.
        refreshCurrentDeviceControlStates();
      },
      rollback: refreshCurrentDeviceControlStates,
    });
  });

  deviceDetailManaged?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailManaged) return;

    const nextChecked = deviceDetailManaged.selected;
    if (nextChecked && devicePowerSetupHint(deviceId)) {
      refreshCurrentDeviceControlStates();
      return;
    }
    const intentGeneration = beginManagedControlIntent(deviceId);
    if (isHomeBatteryDeviceId(deviceId)) {
      await writeBatteryManaged(deviceId, nextChecked, 'device detail', () => {
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      }, refreshCurrentDeviceControlStates);
      return;
    }
    const device = state.latestDevices.find((entry) => entry.id === deviceId);
    const phaseRead = nextChecked && device?.isEvCharger === true
      ? await ensureChargerPhasePresetsRead()
      : { state: 'resolved' as const, presets: state.chargerPhasePresets };
    if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
    if (phaseRead.state === 'unavailable') {
      deviceDetailManaged.selected = false;
      await showToast('Could not read the charger wiring. Refresh devices and try again.', 'warn');
      refreshCurrentDeviceControlStates();
      return;
    }
    const saved = await runSerializedManagedWrite(async () => {
      if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return false;
      const nextMap = await writeFreshSetting<Record<string, boolean>>({
        key: MANAGED_DEVICES,
        context: 'device detail',
        logMessage: 'Failed to update managed device',
        toastMessage: 'Failed to update managed device.',
        // Use the live managed-map snapshot as the fallback so a transient
        // null or non-object SDK read does not erase entries for other
        // devices.
        fallbackValue: state.managedMap,
        readFresh: readRecordSettingStrict<boolean>,
        mutate: (currentMap) => ({
          ...currentMap,
          [deviceId]: nextChecked,
        }),
        commit: (committedMap) => {
          state.managedMap = committedMap;
          refreshSharedDeviceViews();
          refreshCurrentDeviceControlStates();
          refreshDeviceSchedules();
        },
        rollback: refreshCurrentDeviceControlStates,
      });
      return nextMap !== null;
    });
    if (saved && nextChecked && isCurrentManagedControlIntent(deviceId, intentGeneration)) {
      await applyManagedOptInControlMode(deviceId, phaseRead.presets, refreshOpenDeviceDetail);
      // The write above awaited: an owner who has turned Managed back off since
      // must not get Limit switched on for a device they just let go of.
      if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
      await applyManagedOptInLimit(deviceId, () => {
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      }, () => isCurrentManagedControlIntent(deviceId, intentGeneration));
    }
  });
}
