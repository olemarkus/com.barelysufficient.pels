import type { TargetDeviceSnapshot, TemperatureBoostSettings } from '../../../../contracts/src/types.ts';
import { TEMPERATURE_BOOST_SETTINGS } from '../../../../contracts/src/settingsKeys.ts';
import {
  hasTemperatureBoostTarget,
  normalizeTemperatureBoostSettings,
} from '../../../../contracts/src/temperatureBoost.ts';
import {
  deviceDetailTemperatureBoost,
  deviceDetailTemperatureBoostBelow,
  deviceDetailTemperatureBoostBelowRow,
  deviceDetailTemperatureBoostEnabled,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';
import { isSteppedLoadControlModel } from './steppedLoadDraft.ts';

const runSerializedTemperatureBoostWrite = createSerializedAsyncRunner();
const DEFAULT_BOOST_BELOW_C = 55;

type TemperatureBoostHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  refreshOpenDeviceDetail: () => void;
};

export const loadTemperatureBoostSettings = async () => {
  try {
    state.temperatureBoostSettings = normalizeTemperatureBoostSettings(await getSetting(TEMPERATURE_BOOST_SETTINGS));
  } catch (error) {
    await logSettingsError('Failed to load temperature boost settings', error, 'loadTemperatureBoostSettings');
    state.temperatureBoostSettings = {};
  }
};

export const renderTemperatureBoostSettings = (device: TargetDeviceSnapshot | null) => {
  if (!deviceDetailTemperatureBoost || !deviceDetailTemperatureBoostEnabled || !deviceDetailTemperatureBoostBelow) {
    return;
  }
  const visible = device !== null
    && isSteppedLoadControlModel(device)
    && hasTemperatureBoostTarget(device.targets);
  deviceDetailTemperatureBoost.hidden = !visible;
  if (!visible || !device) return;

  const config = state.temperatureBoostSettings[device.id] ?? device.temperatureBoost;
  const enabled = config?.enabled === true;
  deviceDetailTemperatureBoostEnabled.selected = enabled;
  deviceDetailTemperatureBoostEnabled.disabled = false;
  deviceDetailTemperatureBoostBelow.value = String(config?.boostBelowC ?? DEFAULT_BOOST_BELOW_C);
  deviceDetailTemperatureBoostBelow.disabled = !enabled;
  if (deviceDetailTemperatureBoostBelowRow) {
    deviceDetailTemperatureBoostBelowRow.hidden = !enabled;
  }
};

export const initTemperatureBoostHandlers = (deps: TemperatureBoostHandlerDeps) => {
  const persist = async (deviceId: string, nextEnabled: boolean, rawBoostBelowC: number) => {
    await runSerializedTemperatureBoostWrite(async () => {
      await writeFreshSetting<TemperatureBoostSettings>({
        key: TEMPERATURE_BOOST_SETTINGS,
        context: 'device detail',
        logMessage: 'Failed to save temperature boost settings',
        toastMessage: 'Failed to save temperature boost settings.',
        // Use the live temperature-boost snapshot as the fallback so a
        // transient null or non-object SDK read does not erase entries for
        // other devices.
        fallbackValue: state.temperatureBoostSettings,
        // Only normalize when the fresh SDK value is a real object.
        // Anything else returns null so `writeFreshSetting` falls back to
        // the snapshot instead of normalising garbage into `{}`.
        readFresh: (value) => (
          value && typeof value === 'object' && !Array.isArray(value)
            ? normalizeTemperatureBoostSettings(value)
            : null
        ),
        mutate: (currentSettings) => {
          const nextSettings = { ...currentSettings };
          if (nextEnabled) {
            nextSettings[deviceId] = { enabled: true, boostBelowC: rawBoostBelowC };
          } else {
            delete nextSettings[deviceId];
          }
          return nextSettings;
        },
        commit: (nextSettings) => {
          state.temperatureBoostSettings = nextSettings;
          const device = deps.getDeviceById(deviceId);
          if (device) device.temperatureBoost = nextSettings[deviceId];
          deps.refreshOpenDeviceDetail();
        },
        rollback: deps.refreshOpenDeviceDetail,
      });
    });
  };

  deviceDetailTemperatureBoostEnabled?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailTemperatureBoostEnabled || !deviceDetailTemperatureBoostBelow) return;
    const fallback = state.temperatureBoostSettings[deviceId]?.boostBelowC ?? DEFAULT_BOOST_BELOW_C;
    const parsed = Number(deviceDetailTemperatureBoostBelow.value);
    const boostBelowC = Number.isFinite(parsed) ? parsed : fallback;
    await persist(deviceId, deviceDetailTemperatureBoostEnabled.selected, boostBelowC);
  });

  deviceDetailTemperatureBoostBelow?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailTemperatureBoostEnabled || !deviceDetailTemperatureBoostBelow) return;
    if (!deviceDetailTemperatureBoostEnabled.selected) return;
    const parsed = Number(deviceDetailTemperatureBoostBelow.value);
    const boostBelowC = Number.isFinite(parsed) ? parsed : DEFAULT_BOOST_BELOW_C;
    await persist(deviceId, true, boostBelowC);
  });
};
