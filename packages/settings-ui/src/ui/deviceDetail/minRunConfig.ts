import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { DEVICE_MIN_RUN_MINUTES } from '../../../../contracts/src/settingsKeys.ts';
import {
  deviceDetailMinRunClear,
  deviceDetailMinRunMinutes,
  deviceDetailMinRunSave,
} from '../dom.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { createSerializedAsyncRunner, readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';

const runSerializedMinRunWrite = createSerializedAsyncRunner();

// Reflect the per-device override into the input. The override always wins over
// the (read-only here) global default; an absent override shows blank so the
// user knows the global default applies.
export const renderMinRunConfig = (device: SettingsUiDeviceDetailItem) => {
  if (!deviceDetailMinRunMinutes) return;
  const override = state.deviceMinRunMinutes[device.id];
  deviceDetailMinRunMinutes.value = override === undefined ? '' : String(override);
};

export const initMinRunConfigHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
}) => {
  deviceDetailMinRunSave?.addEventListener('click', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    try {
      const minutes = collectMinRunMinutes();
      await persistMinRunConfig({
        deviceId,
        minutes,
        refreshOpenDeviceDetail: params.refreshOpenDeviceDetail,
      });
    } catch (error) {
      await showToastError(error, 'Failed to save minimum run time.');
    }
  });

  deviceDetailMinRunClear?.addEventListener('click', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    try {
      await persistMinRunConfig({
        deviceId,
        // `null` clears the per-device override so the device falls back to the
        // global default / legacy grace.
        minutes: null,
        refreshOpenDeviceDetail: params.refreshOpenDeviceDetail,
      });
    } catch (error) {
      await showToastError(error, 'Failed to clear minimum run time.');
    }
  });
};

export async function persistMinRunConfig(params: {
  deviceId: string;
  minutes: number | null;
  refreshOpenDeviceDetail: () => void;
}) {
  await runSerializedMinRunWrite(async () => {
    await writeFreshSetting<Record<string, number>>({
      key: DEVICE_MIN_RUN_MINUTES,
      context: 'device detail',
      logMessage: 'Failed to save minimum run time',
      toastMessage: 'Failed to save minimum run time.',
      // Use the live per-device map as the fallback so a transient null/non-object
      // SDK read does not erase entries for other devices.
      fallbackValue: state.deviceMinRunMinutes,
      readFresh: (value) => readRecordSettingStrict<number>(value),
      mutate: (currentMap) => {
        const nextMap = { ...currentMap };
        if (params.minutes === null) delete nextMap[params.deviceId];
        else nextMap[params.deviceId] = params.minutes;
        return nextMap;
      },
      commit: (nextMap) => {
        state.deviceMinRunMinutes = nextMap;
        params.refreshOpenDeviceDetail();
      },
      rollback: params.refreshOpenDeviceDetail,
    });
  });
}

// Reads the device-detail input. An empty field clears the override (returns
// null). A non-empty value must be a finite, non-negative integer minute count.
function collectMinRunMinutes(): number | null {
  const raw = deviceDetailMinRunMinutes?.value.trim();
  if (!raw) return null;
  // Strict integer parse — reject fractional input ("2.7") instead of truncating.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Minimum run time must be a non-negative number of minutes.');
  }
  return parsed;
}
