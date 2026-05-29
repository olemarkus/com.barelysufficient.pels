import type { TargetDeviceSnapshot, EvBoostSettings } from '../../../../contracts/src/types.ts';
import { EV_BOOST_SETTINGS } from '../../../../contracts/src/settingsKeys.ts';
import { normalizeEvBoostSettings } from '../../../../contracts/src/evBoost.ts';
import { EV_BOOST_BLOCK_REASONS } from '../../../../shared-domain/src/commandableNowReason.ts';
import { hasSteppedLoadSupport } from '../deviceControlProfiles.ts';
import {
  deviceDetailEvBoost,
  deviceDetailEvBoostBelow,
  deviceDetailEvBoostBelowRow,
  deviceDetailEvBoostEnabled,
  deviceDetailEvBoostStatus,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const runSerializedEvBoostWrite = createSerializedAsyncRunner();
const DEFAULT_BOOST_BELOW_PERCENT = 40;

const normalizeBoostBelowPercent = (value: number, fallback: number): number => (
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback
);

export const supportsEvBoostDevice = (device: TargetDeviceSnapshot | null | undefined): boolean => (
  device?.deviceClass === 'evcharger' && hasSteppedLoadSupport(device)
);

type EvBoostHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  refreshOpenDeviceDetail: () => void;
};

export const loadEvBoostSettings = async () => {
  try {
    state.evBoostSettings = normalizeEvBoostSettings(await getSetting(EV_BOOST_SETTINGS));
  } catch (error) {
    await logSettingsError('Failed to load EV boost settings', error, 'loadEvBoostSettings');
    state.evBoostSettings = {};
  }
};

export const renderEvBoostSettings = (device: TargetDeviceSnapshot | null) => {
  if (!deviceDetailEvBoost || !deviceDetailEvBoostEnabled || !deviceDetailEvBoostBelow || !deviceDetailEvBoostStatus) {
    return;
  }
  const visible = supportsEvBoostDevice(device);
  deviceDetailEvBoost.hidden = !visible;
  if (!visible || !device) return;

  const config = state.evBoostSettings[device.id] ?? device.evBoost;
  const enabled = config?.enabled === true;
  deviceDetailEvBoostEnabled.selected = enabled;
  deviceDetailEvBoostEnabled.disabled = false;
  deviceDetailEvBoostBelow.value = String(config?.boostBelowPercent ?? DEFAULT_BOOST_BELOW_PERCENT);
  deviceDetailEvBoostBelow.disabled = !enabled;
  if (deviceDetailEvBoostBelowRow) {
    deviceDetailEvBoostBelowRow.hidden = !enabled;
  }
  const boostBelowPercent = normalizeBoostBelowPercent(
    config?.boostBelowPercent ?? DEFAULT_BOOST_BELOW_PERCENT,
    DEFAULT_BOOST_BELOW_PERCENT,
  );
  deviceDetailEvBoostStatus.textContent = buildEvBoostStatusText({
    device,
    enabled,
    boostBelowPercent,
  });
};

function buildEvBoostStatusText(params: {
  device: TargetDeviceSnapshot;
  enabled: boolean;
  boostBelowPercent: number;
}): string {
  const { device, enabled, boostBelowPercent } = params;
  if (!enabled) return 'Disabled.';
  if (device.evChargingState === 'plugged_out') return EV_BOOST_BLOCK_REASONS.plugged_out;
  if (device.evChargingState === 'plugged_in_discharging') return EV_BOOST_BLOCK_REASONS.plugged_in_discharging;
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status === 'unknown') {
    return 'Battery level not reported. Boost will not activate.';
  }
  if (stateOfCharge.status === 'stale') return 'Battery level is stale. Boost will not activate.';
  if (stateOfCharge.status === 'invalid') return 'Battery level is invalid. Boost will not activate.';
  if (stateOfCharge.percent < boostBelowPercent) {
    return `Boost active when planning: ${stateOfCharge.percent}% < ${boostBelowPercent}%.`;
  }
  return `Target reached: ${stateOfCharge.percent}% >= ${boostBelowPercent}%.`;
}

export const initEvBoostHandlers = (deps: EvBoostHandlerDeps) => {
  const persist = async (deviceId: string, nextEnabled: boolean, rawBoostBelowPercent: number) => {
    await runSerializedEvBoostWrite(async () => {
      await writeFreshSetting<EvBoostSettings>({
        key: EV_BOOST_SETTINGS,
        context: 'device detail',
        logMessage: 'Failed to save EV boost settings',
        toastMessage: 'Failed to save EV boost settings.',
        // Use the live EV-boost snapshot as the fallback so a transient
        // null or non-object SDK read does not erase entries for other
        // devices.
        fallbackValue: state.evBoostSettings,
        // Only normalize when the fresh SDK value is a real object.
        // Anything else returns null so `writeFreshSetting` falls back to
        // the snapshot instead of normalising garbage into `{}`.
        readFresh: (value) => (
          value && typeof value === 'object' && !Array.isArray(value)
            ? normalizeEvBoostSettings(value)
            : null
        ),
        mutate: (currentSettings) => {
          const nextSettings = { ...currentSettings };
          if (nextEnabled) {
            nextSettings[deviceId] = { enabled: true, boostBelowPercent: rawBoostBelowPercent };
          } else {
            delete nextSettings[deviceId];
          }
          return nextSettings;
        },
        commit: (nextSettings) => {
          state.evBoostSettings = nextSettings;
          const device = deps.getDeviceById(deviceId);
          if (device) device.evBoost = nextSettings[deviceId];
          deps.refreshOpenDeviceDetail();
        },
        rollback: deps.refreshOpenDeviceDetail,
      });
    });
  };

  deviceDetailEvBoostEnabled?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailEvBoostEnabled || !deviceDetailEvBoostBelow) return;
    const fallback = state.evBoostSettings[deviceId]?.boostBelowPercent ?? DEFAULT_BOOST_BELOW_PERCENT;
    const parsed = Number(deviceDetailEvBoostBelow.value);
    const boostBelowPercent = normalizeBoostBelowPercent(parsed, fallback);
    await persist(deviceId, deviceDetailEvBoostEnabled.selected, boostBelowPercent);
  });

  deviceDetailEvBoostBelow?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailEvBoostEnabled || !deviceDetailEvBoostBelow) return;
    if (!deviceDetailEvBoostEnabled.selected) return;
    const parsed = Number(deviceDetailEvBoostBelow.value);
    const boostBelowPercent = normalizeBoostBelowPercent(parsed, DEFAULT_BOOST_BELOW_PERCENT);
    await persist(deviceId, true, boostBelowPercent);
  });
};
